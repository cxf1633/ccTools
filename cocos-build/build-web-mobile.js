'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function parseArgs(args) {
    const options = { 'project-root': process.cwd(), config: 'cocos-build/web/web-mobile.json', 'tool-config': 'cocos-build/config/tool-config.json' };
    const aliases = { '-ProjectRoot': '--project-root', '-ConfigPath': '--config', '-ToolConfigPath': '--tool-config', '-CreatorExe': '--creator', '-SkipBundleDependencyCheck': '--skip-bundle-dependency-check' };
    for (let i = 0; i < args.length; i++) {
        const arg = aliases[args[i]] || args[i];
        if (['--help', '--check', '--skip-bundle-dependency-check'].includes(arg)) options[arg.slice(2)] = true;
        else if (['--project-root', '--config', '--tool-config', '--creator'].includes(arg)) {
            if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error(`参数缺少值：${arg}`);
            options[arg.slice(2)] = args[++i];
        } else throw new Error(`未知参数：${arg}`);
    }
    return options;
}

function resolveBuildPath(root, value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('构建配置缺少 buildPath。');
    if (/^project:\/\//i.test(value)) return path.resolve(root, value.slice('project://'.length).replace(/^[\\/]+/, ''));
    if (/^file:\/\//i.test(value)) return fileURLToPath(value);
    if (path.isAbsolute(value)) return value;
    throw new Error(`不支持的 buildPath：${value}`);
}

function powershell(command, env) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { env, encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'Windows 信息查询失败。');
    return result.stdout.trim();
}

function getRunningCreatorProjects(env) {
    const lines = JSON.parse(powershell([
        "$ErrorActionPreference = 'Stop'",
        '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
        "$items = @(Get-CimInstance Win32_Process -Filter \"Name = 'CocosCreator.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '(?:^|\\s)--type=' } | Select-Object -ExpandProperty CommandLine)",
        'ConvertTo-Json -InputObject $items -Compress',
    ].join('; '), env) || '[]');
    return (Array.isArray(lines) ? lines : [lines]).flatMap(line => {
        const match = String(line).match(/(?:^|\s)--project(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i);
        return match ? [path.resolve(match[1] || match[2] || match[3])] : [];
    });
}

function run(exe, args, root, env, logFile, successCode = 0) {
    return new Promise((resolve, reject) => {
        const log = fs.createWriteStream(logFile);
        const child = spawn(exe, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        log.on('error', error => { child.kill(); reject(error); });
        child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
        child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
        child.on('error', error => { log.end(); reject(error); });
        child.on('close', code => {
            log.end(() => code === successCode ? resolve() : reject(new Error(`进程退出码 ${code}，日志：${logFile}`)));
        });
    });
}

async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    if (options.help) {
        console.log('用法：node tools/cocos-build/build-web-mobile.js [--project-root 路径] [--config 路径] [--tool-config 路径] [--creator 路径] [--check] [--skip-bundle-dependency-check]');
        return;
    }
    if (process.platform !== 'win32') throw new Error('此构建脚本需要在 Windows 中运行。');
    const root = fs.realpathSync(path.resolve(options['project-root']));
    const configPath = path.resolve(root, options.config);
    const toolConfigPath = path.resolve(root, options['tool-config']);
    const config = readJson(configPath);
    const tool = readJson(toolConfigPath);
    if (config.platform !== 'web-mobile') throw new Error('构建配置的 platform 必须为 web-mobile。');
    if (typeof config.outputName !== 'string' || !config.outputName.trim()) throw new Error('构建配置缺少 outputName。');
    const buildRoot = resolveBuildPath(root, config.buildPath);
    const output = path.join(buildRoot, config.outputName);
    const logs = path.join(buildRoot, 'log');
    const logPath = path.join(logs, `${config.outputName}-cli.log`);
    const creator = options.creator || process.env.COCOS_CREATOR_EXE || tool.creatorExe;
    if (!creator || !fs.existsSync(creator)) throw new Error('未找到 Cocos Creator，请设置 --creator、COCOS_CREATOR_EXE 或 tool-config.json 的 creatorExe。');
    const env = { ...process.env, COCOS_WEB_CREATOR_EXE: creator };
    delete env.ELECTRON_RUN_AS_NODE;
    const version = powershell("$ErrorActionPreference = 'Stop'; (Get-Item -LiteralPath $env:COCOS_WEB_CREATOR_EXE).VersionInfo.ProductVersion", env);
    if (!tool.creatorVersion || version !== tool.creatorVersion) throw new Error(`Creator 版本不符：配置 ${tool.creatorVersion}，实际 ${version}`);
    const checker = path.join(__dirname, 'check-bundle-dependencies.js');
    if (!options['skip-bundle-dependency-check'] && !fs.existsSync(checker)) throw new Error(`未找到资源依赖检查脚本：${checker}`);
    console.log(`Cocos Creator：${creator}\n版本：${version}\n项目：${root}\n配置：${configPath}\n输出：${output}\n日志：${logPath}`);
    if (options.check) { console.log('配置检查通过，未执行构建。'); return; }
    if ([configPath, logPath].some(value => value.includes(';'))) throw new Error('构建配置和日志路径不能包含分号。');
    fs.mkdirSync(logs, { recursive: true });
    if (options['skip-bundle-dependency-check']) console.warn('已跳过源资源及构建产物依赖检查。');
    else await run(process.execPath, [checker, '--mode', 'source', '--project-root', root, '--tool-config', toolConfigPath], root, env, path.join(logs, 'dependency-source.log'));
    const projects = getRunningCreatorProjects(env);
    const normalize = value => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
    if (projects.some(project => normalize(project) === normalize(root))) throw new Error(`请先保存并关闭当前项目的 Cocos Creator：${root}`);
    if (projects.length) console.log(`其他 Creator 项目可保持打开：${projects.join('、')}`);
    await run(creator, ['--project', root, '--build', `configPath=${configPath};logDest=${logPath}`], root, env, path.join(logs, 'creator-console.log'), 36);
    const src = path.join(output, 'src');
    if (!fs.existsSync(src) || !fs.readdirSync(src).some(name => /^settings.*\.json$/.test(name) && fs.statSync(path.join(src, name)).isFile())) {
        throw new Error(`Creator 报告成功，但未找到 ${src} 下的 settings JSON。`);
    }
    if (!options['skip-bundle-dependency-check']) await run(process.execPath, [checker, '--mode', 'built', '--output', output, '--tool-config', toolConfigPath], root, env, path.join(logs, 'dependency-built.log'));
    console.log(`网页构建成功：${output}`);
    if (!process.env.CI) {
        const explorer = spawn('explorer.exe', [output], { detached: true, stdio: 'ignore' });
        explorer.on('error', error => console.warn(`无法打开输出目录：${error.message}\n${output}`));
        explorer.unref();
    }
}

if (require.main === module) main().catch(error => { console.error(`网页构建失败：${error.message}`); process.exitCode = 1; });
module.exports = { parseArgs, resolveBuildPath, main };
