'use strict';

const fs = require('fs');
const path = require('path');

const SERIALIZED_ASSET_EXTENSIONS = new Set([
    '.anim',
    '.labelatlas',
    '.material',
    '.mtl',
    '.particle',
    '.prefab',
    '.scene',
    '.spriteatlas',
]);

function parseArguments(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key || !key.startsWith('--') || value === undefined) {
            throw new Error(`参数格式错误：${key || '<empty>'}`);
        }
        args[key.slice(2)] = value;
    }
    return args;
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
        throw new Error(`JSON 文件无效：${filePath}\n${error.message}`);
    }
}

function walkFiles(rootPath) {
    const files = [];
    const pending = [rootPath];

    while (pending.length > 0) {
        const currentPath = pending.pop();
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                pending.push(entryPath);
            } else if (entry.isFile()) {
                files.push(entryPath);
            }
        }
    }

    return files.sort((left, right) => left.localeCompare(right));
}

function createPolicy(toolConfig) {
    const groups = toolConfig.bundleGroups;
    const configuredRules = toolConfig.forbiddenBundleDependencies;
    if (!groups || !Array.isArray(configuredRules) || configuredRules.length === 0) {
        return null;
    }

    const bundleToGroup = new Map();
    for (const groupName of Object.keys(groups).sort()) {
        const bundleNames = groups[groupName];
        if (!Array.isArray(bundleNames)) {
            throw new Error(`Bundle 分组 ${groupName} 必须是数组。`);
        }

        for (const bundleNameValue of bundleNames) {
            const bundleName = String(bundleNameValue || '').trim();
            if (!bundleName) {
                throw new Error(`Bundle 分组 ${groupName} 包含空名称。`);
            }
            if (bundleToGroup.has(bundleName)) {
                throw new Error(`Bundle ${bundleName} 同时属于 ${bundleToGroup.get(bundleName)} 和 ${groupName}。`);
            }
            bundleToGroup.set(bundleName, groupName);
        }
    }

    const rules = configuredRules.map((configuredRule) => {
        const name = String(configuredRule.name || '').trim();
        const fromGroup = String(configuredRule.fromGroup || '').trim();
        const toGroups = [];
        if (configuredRule.toGroup) {
            toGroups.push(String(configuredRule.toGroup));
        }
        if (Array.isArray(configuredRule.toGroups)) {
            toGroups.push(...configuredRule.toGroups.map(String));
        }

        if (!name) {
            throw new Error('存在未配置 name 的 Bundle 依赖规则。');
        }
        if (!Object.prototype.hasOwnProperty.call(groups, fromGroup)) {
            throw new Error(`规则 ${name} 引用了不存在的 fromGroup：${fromGroup}`);
        }
        if (toGroups.length === 0) {
            throw new Error(`规则 ${name} 没有配置 toGroup 或 toGroups。`);
        }
        for (const toGroup of toGroups) {
            if (toGroup !== '*' && !Object.prototype.hasOwnProperty.call(groups, toGroup)) {
                throw new Error(`规则 ${name} 引用了不存在的目标分组：${toGroup}`);
            }
        }

        return { name, fromGroup, toGroups };
    });

    const unknownBundlePolicy = String(toolConfig.unknownBundlePolicy || 'error');
    if (unknownBundlePolicy !== 'error' && unknownBundlePolicy !== 'ignore') {
        throw new Error(`不支持 unknownBundlePolicy=${unknownBundlePolicy}，只能使用 error 或 ignore。`);
    }

    return { bundleToGroup, rules, unknownBundlePolicy };
}

function findForbiddenRule(policy, fromBundle, toBundle) {
    const fromGroup = policy.bundleToGroup.get(fromBundle);
    const toGroup = policy.bundleToGroup.get(toBundle);
    if (!fromGroup || !toGroup) {
        return null;
    }

    return policy.rules.find((rule) => (
        rule.fromGroup === fromGroup
        && (rule.toGroups.includes('*') || rule.toGroups.includes(toGroup))
    )) || null;
}

function discoverBundleRoots(assetsPath, allFiles, policy) {
    const rootsByName = new Map();
    const unknownBundles = [];

    for (const metaPath of allFiles.filter((filePath) => filePath.endsWith('.meta'))) {
        const meta = readJson(metaPath);
        if (meta.importer !== 'directory' || !meta.userData || meta.userData.isBundle !== true) {
            continue;
        }

        const bundlePath = metaPath.slice(0, -'.meta'.length);
        if (!fs.existsSync(bundlePath) || !fs.statSync(bundlePath).isDirectory()) {
            continue;
        }

        const bundleName = String(meta.userData.bundleName || path.basename(bundlePath));
        if (!policy.bundleToGroup.has(bundleName)) {
            if (policy.unknownBundlePolicy === 'error') {
                unknownBundles.push(`${bundleName} (${bundlePath})`);
            } else {
                console.warn(`警告：忽略未登记的源码 Bundle：${bundleName} (${bundlePath})`);
            }
            continue;
        }

        if (rootsByName.has(bundleName)) {
            throw new Error(`Bundle ${bundleName} 存在多个源码根目录：\n${rootsByName.get(bundleName)}\n${bundlePath}`);
        }
        rootsByName.set(bundleName, bundlePath);
    }

    if (unknownBundles.length > 0) {
        throw new Error(`发现未登记到 bundleGroups 的源码 Bundle：\n${unknownBundles.join('\n')}`);
    }

    return Array.from(rootsByName, ([name, rootPath]) => ({ name, path: rootPath }))
        .sort((left, right) => right.path.length - left.path.length);
}

function getOwningBundle(filePath, bundleRoots) {
    for (const bundleRoot of bundleRoots) {
        if (filePath === bundleRoot.path || filePath.startsWith(`${bundleRoot.path}${path.sep}`)) {
            return bundleRoot.name;
        }
    }
    return null;
}

function projectRelative(projectRoot, filePath) {
    return path.relative(projectRoot, filePath) || '.';
}

function checkSource(projectRoot, policy) {
    const assetsPath = path.join(projectRoot, 'assets');
    const allFiles = walkFiles(assetsPath);
    const bundleRoots = discoverBundleRoots(assetsPath, allFiles, policy);
    const uuidIndex = new Map();

    for (const metaPath of allFiles.filter((filePath) => filePath.endsWith('.meta'))) {
        const targetBundle = getOwningBundle(metaPath, bundleRoots);
        if (!targetBundle) {
            continue;
        }

        const targetAsset = metaPath.slice(0, -'.meta'.length);
        const metaText = fs.readFileSync(metaPath, 'utf8');
        const uuidPattern = /"uuid"\s*:\s*"([^"]+)"/g;
        let uuidMatch;
        while ((uuidMatch = uuidPattern.exec(metaText)) !== null) {
            const uuid = uuidMatch[1];
            const existing = uuidIndex.get(uuid);
            if (existing && existing.asset !== targetAsset) {
                throw new Error(`资源 UUID 重复：${uuid}\n${existing.asset}\n${targetAsset}`);
            }
            uuidIndex.set(uuid, { bundle: targetBundle, asset: targetAsset });
        }
    }

    const violationByKey = new Map();
    for (const sourcePath of allFiles.filter((filePath) => SERIALIZED_ASSET_EXTENSIONS.has(path.extname(filePath).toLowerCase()))) {
        const sourceBundle = getOwningBundle(sourcePath, bundleRoots);
        if (!sourceBundle) {
            continue;
        }

        const lines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const referencePattern = /"__uuid__"\s*:\s*"([^"]+)"/g;
            let referenceMatch;
            while ((referenceMatch = referencePattern.exec(lines[lineIndex])) !== null) {
                const uuid = referenceMatch[1];
                const target = uuidIndex.get(uuid);
                if (!target || target.bundle === sourceBundle) {
                    continue;
                }

                const rule = findForbiddenRule(policy, sourceBundle, target.bundle);
                if (!rule) {
                    continue;
                }

                const key = [sourceBundle, target.bundle, sourcePath, target.asset, rule.name].join('|');
                if (!violationByKey.has(key)) {
                    violationByKey.set(key, {
                        sourceBundle,
                        sourceGroup: policy.bundleToGroup.get(sourceBundle),
                        sourcePath,
                        line: lineIndex + 1,
                        targetBundle: target.bundle,
                        targetGroup: policy.bundleToGroup.get(target.bundle),
                        targetAsset: target.asset,
                        rule: rule.name,
                    });
                }
            }
        }
    }

    const violations = Array.from(violationByKey.values()).sort((left, right) => (
        left.sourcePath.localeCompare(right.sourcePath)
        || left.line - right.line
        || left.targetAsset.localeCompare(right.targetAsset)
    ));

    if (violations.length === 0) {
        console.log(`源码 Bundle UUID 检查通过：扫描 ${bundleRoots.length} 个 Bundle，建立 ${uuidIndex.size} 个 UUID 索引。`);
        return true;
    }

    const grouped = new Map();
    for (const violation of violations) {
        const key = [violation.sourceBundle, violation.targetBundle, violation.sourcePath, violation.rule].join('|');
        if (!grouped.has(key)) {
            grouped.set(key, []);
        }
        grouped.get(key).push(violation);
    }

    console.error('');
    console.error('【源码 Bundle 资源依赖检查失败】');
    console.error('原因：业务 Bundle 之间禁止直接引用资源。');

    for (const items of grouped.values()) {
        const first = items[0];
        console.error('');
        console.error(`来源 Bundle：${first.sourceBundle}（${first.sourceGroup}）`);
        console.error(`引用 Bundle：${first.targetBundle}（${first.targetGroup}）`);
        console.error(`来源文件：${projectRelative(projectRoot, first.sourcePath)}`);
        console.error(`违规资源：${items.length} 个`);
        for (const item of items.sort((left, right) => left.line - right.line)) {
            console.error(`  第 ${item.line} 行 -> ${projectRelative(projectRoot, item.targetAsset)}`);
        }
        console.error(`命中规则：${first.rule}`);
    }

    console.error('');
    console.error('处理建议：将这些资源移动到允许依赖的公共 Bundle，或者让来源 Prefab 使用自己 Bundle 内的资源。');
    console.error('Cocos Creator 尚未启动，本次没有执行构建。');
    return false;
}

function checkBuilt(outputPath, policy) {
    const bundleAssetsPath = path.join(outputPath, 'assets');
    const violations = [];
    const bundleEntries = fs.readdirSync(bundleAssetsPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name));

    for (const bundleEntry of bundleEntries) {
        const bundleName = bundleEntry.name;
        if (!policy.bundleToGroup.has(bundleName)) {
            if (policy.unknownBundlePolicy === 'error') {
                violations.push(`未登记 Bundle：${bundleName}`);
            } else {
                console.warn(`警告：忽略未登记的构建 Bundle：${bundleName}`);
            }
            continue;
        }

        const bundlePath = path.join(bundleAssetsPath, bundleName);
        const configFiles = fs.readdirSync(bundlePath)
            .filter((name) => /^config.*\.json$/i.test(name))
            .map((name) => ({ name, mtime: fs.statSync(path.join(bundlePath, name)).mtimeMs }))
            .sort((left, right) => right.mtime - left.mtime);
        if (configFiles.length === 0) {
            throw new Error(`找不到 Bundle ${bundleName} 的 config*.json：${bundlePath}`);
        }

        const bundleConfig = readJson(path.join(bundlePath, configFiles[0].name));
        const dependencies = Array.isArray(bundleConfig.deps) ? bundleConfig.deps : [];
        console.log(`Bundle 依赖：${bundleName} -> ${dependencies.length > 0 ? dependencies.join(', ') : '<无>'}`);

        for (const dependencyName of dependencies) {
            if (!policy.bundleToGroup.has(dependencyName)) {
                if (policy.unknownBundlePolicy === 'error') {
                    violations.push(`${bundleName} -> 未登记 Bundle：${dependencyName}`);
                }
                continue;
            }

            const rule = findForbiddenRule(policy, bundleName, dependencyName);
            if (rule) {
                violations.push(
                    `${bundleName} [${policy.bundleToGroup.get(bundleName)}] -> `
                    + `${dependencyName} [${policy.bundleToGroup.get(dependencyName)}]，规则：${rule.name}`,
                );
            }
        }
    }

    if (violations.length === 0) {
        console.log('构建产物 Bundle deps 检查通过。');
        return true;
    }

    console.error('');
    console.error('【构建产物 Bundle deps 检查失败】');
    for (const violation of violations) {
        console.error(`  ${violation}`);
    }
    return false;
}

function main() {
    const args = parseArguments(process.argv.slice(2));
    const mode = args.mode;
    const toolConfigPath = path.resolve(args['tool-config'] || '');
    if (!mode || !toolConfigPath) {
        throw new Error('必须提供 --mode 和 --tool-config。');
    }

    const policy = createPolicy(readJson(toolConfigPath));
    if (!policy) {
        console.log('未配置 Bundle 依赖检查规则。');
        return true;
    }

    if (mode === 'source') {
        if (!args['project-root']) {
            throw new Error('source 模式必须提供 --project-root。');
        }
        return checkSource(path.resolve(args['project-root']), policy);
    }
    if (mode === 'built') {
        if (!args.output) {
            throw new Error('built 模式必须提供 --output。');
        }
        return checkBuilt(path.resolve(args.output), policy);
    }

    throw new Error(`不支持的检查模式：${mode}`);
}

try {
    if (!main()) {
        process.exitCode = 1;
    }
} catch (error) {
    console.error('');
    console.error('【Bundle 依赖检查执行失败】');
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 2;
}
