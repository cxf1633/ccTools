'use strict';

// 独立 Node.js 工具，不参与 Cocos 的脚本编译。
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
let buildLogPath;

function parseArgs(args) {
    const options = { mode: 'debug', 'project-root': process.cwd(), config: 'cocos-build/build-config-android.json', 'tool-config': 'cocos-build/tool-config.json' };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (['--help', '--check', '--skip-cocos', '--resources-only'].includes(arg)) options[arg.slice(2)] = true;
        else if (['--mode', '--project-root', '--config', '--tool-config', '--creator', '--java-home', '--log-directory'].includes(arg)) {
            if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`参数缺少值：${arg}`);
            options[arg.slice(2)] = args[++i];
        } else throw new Error(`未知参数：${arg}`);
    }
    if (!['debug', 'release'].includes(options.mode)) throw new Error('--mode 只能设置为 debug（调试）或 release（发布）');
    if (options['resources-only'] && options['skip-cocos']) throw new Error('--resources-only 不能与 --skip-cocos 同时使用。');
    return options;
}

function run(exe, args, cwd, env, logFile, successCode = 0) {
    return new Promise((resolve, reject) => {
        const log = fs.createWriteStream(logFile);
        // cmd 的 /c 命令由调用方完成引用；禁用 Node 的 CRT 引号转义，避免将 \" 传给 Gradle。
        const windowsVerbatimArguments = process.platform === 'win32' && path.basename(exe).toLowerCase() === 'cmd.exe';
        const child = spawn(exe, args, { cwd, env, windowsHide: true, windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] });
        log.on('error', error => { child.kill(); reject(error); });
        child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
        child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
        child.on('error', error => { log.end(); reject(error); });
        child.on('close', code => {
            log.end(() => {
                if (code === successCode) resolve();
                else reject(new Error(`${path.basename(exe)} 执行失败，退出码：${code}。日志：${logFile}`));
            });
        });
    });
}

function findMetadata(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? findMetadata(file) : entry.name === 'output-metadata.json' ? [file] : [];
    });
}

function readInjectedManifest(mainPath) {
    const main = fs.readFileSync(mainPath, 'utf8');
    const prefix = 'window.__thirteenHotUpdate = restore(';
    const start = main.indexOf(prefix);
    const contentStart = start + prefix.length;
    const contentEnd = main.indexOf(', jsb.fileUtils);', contentStart);
    if (start < 0 || contentEnd < 0) throw new Error(`APK 启动入口未包含包内资源清单：${mainPath}`);
    const boot = JSON.parse(main.slice(contentStart, contentEnd));
    if (!boot?.manifest?.assets || typeof boot.manifest.assets !== 'object') {
        throw new Error(`APK 启动入口中的包内资源清单无效：${mainPath}`);
    }
    return boot.manifest;
}

function normalizeProjectPath(projectPath) {
    return path.resolve(projectPath).replace(/[\\/]+$/, '').toLowerCase();
}

function getRunningCreatorProjects(env) {
    const command = [
        "$ErrorActionPreference = 'Stop'",
        '$utf8 = New-Object System.Text.UTF8Encoding($false)',
        '[Console]::OutputEncoding = $utf8',
        '$OutputEncoding = $utf8',
        "$items = @(Get-CimInstance Win32_Process -Filter \"Name = 'CocosCreator.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '(?:^|\\s)--type=' } | Select-Object -ExpandProperty CommandLine)",
        'ConvertTo-Json -InputObject $items -Compress',
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command],
        { env, encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) {
        throw new Error('无法检查 Cocos Creator 打开的项目。');
    }

    const output = result.stdout.trim();
    const commandLines = output ? JSON.parse(output) : [];
    return (Array.isArray(commandLines) ? commandLines : [commandLines]).flatMap(commandLine => {
        const match = String(commandLine).match(/(?:^|\s)--project(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i);
        return match ? [path.resolve(match[1] || match[2] || match[3])] : [];
    });
}

async function main() {
    const startedAt = process.hrtime.bigint();
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log('用法：node tools/cocos-build/build-android.js [--mode debug|release] [--skip-cocos] [--resources-only] [--check]\n' +
            '       [--project-root 项目目录] [--config 路径] [--tool-config 路径] [--creator 路径] [--java-home 路径] [--log-directory 路径]\n' +
            '项目目录默认为当前工作目录；相对配置路径以项目目录为基准。\n' +
            '默认：重新构建 Cocos，编译调试版 APK，并复制到 build/apk/<版本号>_<时-分>。\n' +
            '--check：仅检查配置和 Java，不构建。--skip-cocos：跳过 Cocos，编译现有 Android 工程。\n' +
            '--resources-only：重新构建 Cocos Android 资源并完成依赖检查，在 APK 清单注入和 Gradle 前停止，不生成 APK。');
        return;
    }
    if (process.platform !== 'win32') throw new Error('此打包脚本需要在 Windows 系统中运行。');
    const root = path.resolve(options['project-root']);
    const configPath = path.resolve(root, options.config);
    const config = readJson(configPath);
    const toolConfigPath = path.resolve(root, options['tool-config']);
    const tool = readJson(toolConfigPath);
    const releaseConfigPath = path.resolve(root, tool.android?.releaseConfig || 'cocos-build/release-config.json');
    const releaseConfig = readJson(releaseConfigPath);
    const version = releaseConfig.platforms?.android?.version;
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || '')) {
        throw new Error(`版本格式无效，请在 ${releaseConfigPath} 的 platforms.android.version 填写三段数字，例如 0.1.15。`);
    }
    const apkNameTemplate = tool.android?.apkNameTemplate || '{index}-v{version}-{originalName}';
    if (typeof apkNameTemplate !== 'string' || /\{(?!index\}|version\}|originalName\}|mode\})/.test(apkNameTemplate)) {
        throw new Error('android.apkNameTemplate 只支持 {index}、{version}、{originalName}、{mode} 占位符。');
    }
    const dependencyChecker = path.join(__dirname, 'check-bundle-dependencies.js');
    if (!fs.existsSync(dependencyChecker)) throw new Error(`未找到共享资源依赖检查器，请确认 tools/cocos-build 子模块已初始化：${dependencyChecker}`);
    if (config.platform !== 'android') throw new Error('构建配置中的 platform 必须为 android。');
    if (!config.buildPath || !config.outputName) throw new Error('构建配置必须填写 buildPath（构建目录）和 outputName（输出名称）。');
    const buildBase = config.buildPath.replace(/^project:\/\//, '');
    const output = path.resolve(root, buildBase, config.outputName);
    const proj = path.join(output, 'proj');
    const creator = options.creator || process.env.COCOS_CREATOR_EXE || tool.creatorExe;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let javaHome = options['java-home'] || env.JAVA_HOME;
    const studioConfig = path.join(proj, '.gradle', 'config.properties');
    if (!javaHome && fs.existsSync(studioConfig)) {
        const match = fs.readFileSync(studioConfig, 'utf8').match(/^java\.home=(.*)$/m);
        if (match) javaHome = match[1].trim().replace(/\\(.)/g, '$1');
    }
    if (javaHome) {
        env.JAVA_HOME = javaHome;
        // Windows 环境变量名不区分大小写；避免同时传递 Path 和 PATH。
        const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path';
        env[pathKey] = `${path.join(javaHome, 'bin')};${env[pathKey] || ''}`;
    }
    const java = javaHome ? path.join(javaHome, 'bin', 'java.exe') : 'java.exe';
    const javaResult = spawnSync(java, ['-version'], { env, encoding: 'utf8', windowsHide: true });
    if (javaResult.error || javaResult.status !== 0) throw new Error('无法运行 Java。请设置 JAVA_HOME，或通过 --java-home 指定 Android Studio 的 jbr 目录。');
    console.log((javaResult.stderr || javaResult.stdout).trim());
    if (!options['skip-cocos']) {
        if (!creator || !fs.existsSync(creator)) throw new Error(`未找到 Cocos Creator，请在 ${toolConfigPath} 中设置 creatorExe，或通过 --creator 指定路径。`);
        if (readJson(path.join(root, 'package.json')).creator.version !== tool.creatorVersion) throw new Error('tool-config.json 中的 creatorVersion 与项目的 Cocos 版本不一致。');
    } else if (!fs.existsSync(path.join(proj, 'gradlew.bat'))) {
        throw new Error(`请先通过 Cocos 构建生成 Android 工程：${proj}`);
    }
    console.log(`构建模式：${options.mode === 'debug' ? '调试版（Debug）' : '发布版（Release）'}\n配置文件：${configPath}\nAndroid 工程：${proj}\nJava 路径：${java}`);
    console.log(`版本：${version}（${releaseConfigPath}）`);
    if (options.mode === 'release' && config.packages?.android?.useDebugKeystore) {
        console.log('提示：当前配置使用 Cocos 调试证书，正式发布前请配置正式签名证书。');
    }
    if (options.check) {
        console.log('配置检查通过（资源依赖、SDK、NDK 和编译依赖将在实际打包时验证）。');
        return;
    }
    // 北京时间，精确到分钟；Windows 文件夹名不能包含冒号。
    const beijingTime = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    const minuteStamp = beijingTime.slice(0, 16).replace('T', '_').replace(':', '-');
    const apkStamp = `${version}_${beijingTime.slice(11, 16).replace(':', '-')}`;
    const requestedLogDirectory = options['log-directory'] ? path.resolve(root, options['log-directory']) : null;
    if (requestedLogDirectory) {
        const relative = path.relative(path.join(root, 'build'), requestedLogDirectory);
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
            throw new Error('--log-directory 必须是项目 build/ 下的新目录。');
        }
    }
    const outputDirectory = requestedLogDirectory
        ? path.dirname(requestedLogDirectory)
        : options['resources-only']
            ? path.resolve(root, tool.android?.resourceBuildLogDirectory || 'build/hot-update-build')
            : path.resolve(root, tool.android?.apkOutputDirectory || 'build/apk');
    fs.mkdirSync(outputDirectory, { recursive: true });
    let stamp = requestedLogDirectory
        ? path.basename(requestedLogDirectory)
        : options['resources-only'] ? minuteStamp : apkStamp;
    let destination;
    for (let sequence = 1; ; sequence++) {
        destination = requestedLogDirectory || path.join(outputDirectory, stamp);
        try {
            fs.mkdirSync(destination);
            break;
        } catch (error) {
            if (error.code !== 'EEXIST' || requestedLogDirectory) throw error;
            stamp = `${minuteStamp}_${sequence + 1}`;
        }
    }
    const logs = destination;
    buildLogPath = path.join(logs, 'build.log');
    fs.writeFileSync(buildLogPath, `开始时间：${new Date().toISOString()}\n构建模式：${options.mode}\n配置文件：${configPath}\nAndroid 工程：${proj}\nJava 路径：${java}\n跳过 Cocos：${options['skip-cocos'] ? '是' : '否'}\n`, 'utf8');
    console.log(`${options['resources-only'] ? '资源构建' : '打包'}日志目录：${logs}`);
    fs.appendFileSync(buildLogPath, `版本：${version}\n发布配置：${releaseConfigPath}\n`, 'utf8');
    console.log('开始检查源资源跨 Bundle 引用和多语言默认资源。');
    await run(process.execPath, [dependencyChecker, '--mode', 'source', '--project-root', root, '--tool-config', toolConfigPath],
        root, env, path.join(logs, 'dependency-source.log'));
    fs.appendFileSync(buildLogPath, '源资源依赖检查通过。\n', 'utf8');
    if (!options['skip-cocos']) {
        const runningCreatorProjects = getRunningCreatorProjects(env);
        const normalizedRoot = normalizeProjectPath(root);
        if (runningCreatorProjects.some(project => normalizeProjectPath(project) === normalizedRoot)) {
            throw new Error(`完整构建前，请先保存并关闭当前项目的 Cocos Creator：${root}`);
        }
        const otherProjects = runningCreatorProjects.filter(project => normalizeProjectPath(project) !== normalizedRoot);
        if (otherProjects.length > 0) {
            console.log(`检测到其他 Cocos Creator 项目，允许继续构建：${otherProjects.join('、')}`);
        }
        config.debug = options.mode === 'debug';
        // 运行时配置可能包含签名信息，继续保留在 temp，不随 APK 归档。
        const configDirectory = path.join(root, 'temp', 'builder', 'log', `android-${stamp}`);
        fs.mkdirSync(configDirectory, { recursive: true });
        const runtimeConfig = path.join(configDirectory, 'build-config.json');
        fs.writeFileSync(runtimeConfig, JSON.stringify(config, null, 2));
        const buildOptions = `platform=android;stage=build;configPath=${runtimeConfig};logDest=${path.join(logs, 'creator.log')}`;
        if (runtimeConfig.includes(';')) throw new Error('使用 Cocos 命令行构建时，项目路径不能包含分号。');
        await run(creator, ['--project', root, '--build', buildOptions], root, env, path.join(logs, 'creator-console.log'), 36);
    }
    // 原生资源位于 data/assets；共享检查器接收 assets 的父目录。
    const nativeData = path.join(output, 'data');
    const bundleAssets = path.join(nativeData, 'assets');
    if (!fs.existsSync(bundleAssets) || !fs.readdirSync(bundleAssets, { withFileTypes: true }).some(entry => entry.isDirectory())) {
        throw new Error(`未找到 Android Bundle 产物，请先执行完整构建：${bundleAssets}`);
    }
    if (options['skip-cocos']) {
        console.log('已跳过 Cocos：检查现有 Android 产物，其内容可能与当前源码不同。');
    }
    console.log('开始检查 Android 构建产物的 Bundle 依赖。');
    await run(process.execPath, [dependencyChecker, '--mode', 'built', '--output', nativeData, '--tool-config', toolConfigPath],
        root, env, path.join(logs, 'dependency-built.log'));
    fs.appendFileSync(buildLogPath, 'Android 构建产物依赖检查通过。\n', 'utf8');
    // prepareScript 注入的是 APK 启动清单。资源模式不会生成 APK，且注入后的 main.js
    // 不能作为差异基准，否则会把刚构建的资源与自身比较。
    let packagedManifest;
    if (tool.android?.prepareScript && !options['resources-only']) {
        await run(process.execPath, [path.resolve(root, tool.android.prepareScript), '--platform', 'android', '--data', nativeData],
            root, env, path.join(logs, 'prepare-hot-update.log'));
        packagedManifest = readInjectedManifest(path.join(nativeData, 'main.js'));
    }
    if (options['resources-only']) {
        const elapsedSeconds = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e9);
        const elapsed = `${Math.floor(elapsedSeconds / 60)} 分 ${elapsedSeconds % 60} 秒`;
        fs.appendFileSync(buildLogPath, `Android 资源构建成功。结束时间：${new Date().toISOString()}\n资源构建总耗时：${elapsed}\n`, 'utf8');
        console.log(`Android 资源构建成功，未运行 Gradle、未生成 APK。总耗时：${elapsed}\n日志目录：${logs}`);
        return;
    }
    const gradleWrapper = path.join(proj, 'gradlew.bat');
    if (!fs.existsSync(gradleWrapper)) throw new Error(`未找到 Gradle Wrapper，请确认 Android 工程已生成：${proj}`);
    const task = options.mode === 'debug' ? 'assembleDebug' : 'assembleRelease';
    // 在 AGP 完成 DSL 配置时注入版本，覆盖模板默认值；完整构建和跳过 Cocos 均生效。
    // 使用临时 init script，不改动 Cocos 生成或用户维护的 build.gradle。
    const versionInit = path.join(logs, 'version.init.gradle');
    fs.writeFileSync(versionInit, `gradle.beforeProject { project ->
    project.plugins.withId('com.android.application') {
        project.extensions.getByName('androidComponents').finalizeDsl { android ->
            android.defaultConfig.versionName = '${version}'
        }
    }
}
`, 'utf8');
    env.COCOS_ANDROID_VERSION_INIT = versionInit;
    // 固定命令，用户输入不拼入 cmd 命令，支持中文及空格路径。
    // 用 call + 绝对路径调用 Wrapper：进程环境若设置了 NoDefaultCurrentDirectoryInExePath，
    // cmd 不会搜索当前目录，裸写 gradlew.bat 会报“不是内部或外部命令”。
    // 命令串必须以非引号字符开头，否则 cmd /s 会剥掉首个引号。
    await run(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c',
        `call "${gradleWrapper}" ${task} -PPROP_IS_DEBUG=${options.mode === 'debug'} --init-script "%COCOS_ANDROID_VERSION_INIT%" --console=plain --stacktrace`],
    proj, env, path.join(logs, 'gradle.log'));
    // 使用 AGP 元数据取 APK，不依赖 Cocos 动态模块名，也不误收其他 variant 的历史 APK。
    const apks = [];
    for (const file of findMetadata(path.join(proj, 'build'))) {
        const metadata = readJson(file);
        if (metadata.variantName !== options.mode || metadata.artifactType?.type !== 'APK') continue;
        for (const element of metadata.elements || []) {
            if (element.versionName !== version) {
                throw new Error(`APK 版本与 version 不一致：预期 ${version}，实际 ${element.versionName}。元数据：${file}`);
            }
            const apk = path.resolve(path.dirname(file), element.outputFile);
            if (!apk.startsWith(path.dirname(file) + path.sep) || !apk.endsWith('.apk') || !fs.existsSync(apk)) {
                throw new Error(`APK 路径无效或文件不存在，请检查元数据文件：${file}`);
            }
            apks.push({ apk, version: element.versionName || String(element.versionCode || 'unknown') });
        }
    }
    if (!apks.length) throw new Error(`Gradle 编译成功，但在 ${proj}/build 下未找到 ${options.mode} 版本的 APK 元数据。`);
    for (const [index, { apk, version: apkVersion }] of apks.entries()) {
        const safeVersion = apkVersion.replace(/[^a-zA-Z0-9._-]/g, '_');
        const values = { index: String(index + 1), version: safeVersion, originalName: path.basename(apk), mode: options.mode };
        const apkName = apkNameTemplate.replace(/\{(index|version|originalName|mode)\}/g, (_, key) => values[key]);
        if (/[<>:"/\\|?*\x00-\x1f{}]/.test(apkName) || !apkName.toLowerCase().endsWith('.apk')) {
            throw new Error(`APK 命名模板生成了无效文件名：${apkName}`);
        }
        const target = path.join(destination, apkName);
        fs.copyFileSync(apk, target, fs.constants.COPYFILE_EXCL);
        console.log(`APK 输出：${target}`);
        fs.appendFileSync(buildLogPath, `APK 输出：${target}\n`, 'utf8');
    }
    if (packagedManifest) {
        const archivedManifest = path.join(destination, 'project.manifest');
        const baselineManifest = path.join(root, 'build', 'package-baseline', 'android', 'project.manifest');
        const content = JSON.stringify(packagedManifest, null, 2);
        fs.writeFileSync(archivedManifest, content, 'utf8');
        fs.mkdirSync(path.dirname(baselineManifest), { recursive: true });
        fs.writeFileSync(baselineManifest, content, 'utf8');
        console.log(`整包资源基准：${baselineManifest}`);
        fs.appendFileSync(buildLogPath, `整包资源基准：${baselineManifest}\n`, 'utf8');
    }
    const elapsedSeconds = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e9);
    const elapsed = `${Math.floor(elapsedSeconds / 60)} 分 ${elapsedSeconds % 60} 秒`;
    fs.appendFileSync(buildLogPath, `打包成功。结束时间：${new Date().toISOString()}\n打包总耗时：${elapsed}\n`, 'utf8');
    console.log(`打包成功。打包总耗时：${elapsed}\n日志目录：${logs}`);
}

main().catch(error => {
    const message = `打包失败：${error.message}`;
    console.error(message);
    if (buildLogPath) {
        try {
            fs.appendFileSync(buildLogPath, `${message}\n`, 'utf8');
        } catch (logError) {
            console.error(`写入打包日志失败：${logError.message}`);
        }
    }
    process.exitCode = 1;
});
