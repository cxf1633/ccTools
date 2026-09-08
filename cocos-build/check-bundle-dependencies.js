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

const LANGUAGE_DEFAULT_ASSET_EXTENSIONS = new Set(['.prefab', '.scene']);
const LANGUAGE_COMPONENT_TYPES = new Map([
    ['04444SP5AFPd43ijqwWoFt2', 'LanguageSprite'],
    ['4e7e0XHDXpC9pDHNCN407j7', 'LanguageSpine'],
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

    const defaultLanguageBundle = String(toolConfig.defaultLanguageBundle || '').trim();
    if (defaultLanguageBundle && !bundleToGroup.has(defaultLanguageBundle)) {
        throw new Error(`默认多语言 Bundle 未登记到 bundleGroups：${defaultLanguageBundle}`);
    }

    return { bundleToGroup, rules, unknownBundlePolicy, defaultLanguageBundle };
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

function getNodePath(serializedObjects, nodeIndex) {
    const names = [];
    const visited = new Set();
    let currentIndex = nodeIndex;

    while (Number.isInteger(currentIndex) && !visited.has(currentIndex)) {
        visited.add(currentIndex);
        const node = serializedObjects[currentIndex];
        if (!node || typeof node !== 'object') {
            break;
        }

        names.unshift(String(node._name || `<Node ${currentIndex}>`));
        currentIndex = node._parent && Number.isInteger(node._parent.__id__)
            ? node._parent.__id__
            : null;
    }

    return names.join('/');
}

function collectUuidValues(value, output) {
    if (!value || typeof value !== 'object') {
        return;
    }
    if (typeof value.__uuid__ === 'string') {
        output.push(value.__uuid__);
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectUuidValues(item, output);
        }
        return;
    }

    for (const child of Object.values(value)) {
        collectUuidValues(child, output);
    }
}

function parseSerializedSource(sourcePath) {
    const sourceText = fs.readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, '');
    try {
        return { sourceText, serialized: JSON.parse(sourceText) };
    } catch (_error) {
        return { sourceText, serialized: null };
    }
}

function collectSerializedUuidReferences(sourcePath, parsedSource) {
    const { sourceText, serialized } = parsedSource || parseSerializedSource(sourcePath);
    if (serialized === null) {
        const references = [];
        const referencePattern = /"__uuid__"\s*:\s*"([^"]+)"/g;
        let referenceMatch;
        while ((referenceMatch = referencePattern.exec(sourceText)) !== null) {
            references.push({ uuid: referenceMatch[1], controlPath: '<无法解析控件>' });
        }
        return references;
    }

    if (!Array.isArray(serialized)) {
        const uuids = [];
        collectUuidValues(serialized, uuids);
        return uuids.map((uuid) => ({ uuid, controlPath: '<资源文件本身>' }));
    }

    const ownerNodeByObject = new Map();
    for (let index = 0; index < serialized.length; index += 1) {
        const object = serialized[index];
        if (!object || typeof object !== 'object') {
            continue;
        }

        if (object.__type__ === 'cc.Node') {
            ownerNodeByObject.set(index, index);
        }

        const directNodeId = object.node && Number.isInteger(object.node.__id__)
            ? object.node.__id__
            : object._node && Number.isInteger(object._node.__id__)
                ? object._node.__id__
                : null;
        if (directNodeId !== null) {
            ownerNodeByObject.set(index, directNodeId);
        }
    }

    for (let nodeIndex = 0; nodeIndex < serialized.length; nodeIndex += 1) {
        const node = serialized[nodeIndex];
        if (!node || node.__type__ !== 'cc.Node') {
            continue;
        }

        for (const componentReference of Array.isArray(node._components) ? node._components : []) {
            if (componentReference && Number.isInteger(componentReference.__id__)) {
                ownerNodeByObject.set(componentReference.__id__, nodeIndex);
            }
        }
        if (node._prefab && Number.isInteger(node._prefab.__id__)) {
            ownerNodeByObject.set(node._prefab.__id__, nodeIndex);
        }
    }

    for (let index = 0; index < serialized.length; index += 1) {
        const object = serialized[index];
        const ownerNodeId = ownerNodeByObject.get(index);
        if (ownerNodeId === undefined || !object || typeof object !== 'object') {
            continue;
        }
        if (object.__prefab && Number.isInteger(object.__prefab.__id__)) {
            ownerNodeByObject.set(object.__prefab.__id__, ownerNodeId);
        }
    }

    const references = [];
    for (let index = 0; index < serialized.length; index += 1) {
        const uuids = [];
        collectUuidValues(serialized[index], uuids);
        if (uuids.length === 0) {
            continue;
        }

        const ownerNodeId = ownerNodeByObject.get(index);
        const controlPath = ownerNodeId === undefined
            ? '<未关联到节点>'
            : getNodePath(serialized, ownerNodeId);
        for (const uuid of uuids) {
            references.push({ uuid, controlPath });
        }
    }

    return references;
}

function collectLanguageDefaultAssetViolations(sourcePath, parsedSource, uuidIndex, defaultLanguageBundle) {
    if (!defaultLanguageBundle || !Array.isArray(parsedSource.serialized)) {
        return [];
    }

    const serialized = parsedSource.serialized;
    const componentIndexesByNode = new Map();
    for (let index = 0; index < serialized.length; index += 1) {
        const object = serialized[index];
        if (!object || typeof object !== 'object') {
            continue;
        }

        const nodeIndex = object.node && Number.isInteger(object.node.__id__)
            ? object.node.__id__
            : object._node && Number.isInteger(object._node.__id__)
                ? object._node.__id__
                : null;
        if (nodeIndex === null) {
            continue;
        }
        if (!componentIndexesByNode.has(nodeIndex)) {
            componentIndexesByNode.set(nodeIndex, []);
        }
        componentIndexesByNode.get(nodeIndex).push(index);
    }

    const violations = [];
    for (let index = 0; index < serialized.length; index += 1) {
        const component = serialized[index];
        const componentName = component && LANGUAGE_COMPONENT_TYPES.get(component.__type__);
        if (!componentName) {
            continue;
        }

        const nodeIndex = component.node && Number.isInteger(component.node.__id__)
            ? component.node.__id__
            : component._node && Number.isInteger(component._node.__id__)
                ? component._node.__id__
                : null;
        if (nodeIndex === null) {
            continue;
        }

        const componentIndexes = componentIndexesByNode.get(nodeIndex) || [];
        const resourceComponent = componentIndexes
            .map((componentIndex) => serialized[componentIndex])
            .find((item) => componentName === 'LanguageSprite'
                ? item && item.__type__ === 'cc.Sprite'
                : item && item.__type__ === 'sp.Skeleton');
        const resourceReference = componentName === 'LanguageSprite'
            ? resourceComponent && resourceComponent._spriteFrame
            : resourceComponent && (resourceComponent._skeletonData || resourceComponent.skeletonData);
        const resourceUuid = resourceReference && typeof resourceReference.__uuid__ === 'string'
            ? resourceReference.__uuid__
            : '';
        if (!resourceUuid) {
            continue;
        }

        const target = uuidIndex.get(resourceUuid);
        if (target && target.bundle === defaultLanguageBundle) {
            continue;
        }

        violations.push({
            sourcePath,
            controlPath: getNodePath(serialized, nodeIndex),
            component: componentName,
            dataID: String(component._dataID || ''),
            resourceUuid,
            targetAsset: target ? target.asset : null,
            targetBundle: target ? target.bundle : null,
        });
    }

    return violations;
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
    const languageDefaultViolations = [];
    for (const sourcePath of allFiles.filter((filePath) => SERIALIZED_ASSET_EXTENSIONS.has(path.extname(filePath).toLowerCase()))) {
        const parsedSource = parseSerializedSource(sourcePath);
        if (LANGUAGE_DEFAULT_ASSET_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
            languageDefaultViolations.push(...collectLanguageDefaultAssetViolations(
                sourcePath,
                parsedSource,
                uuidIndex,
                policy.defaultLanguageBundle,
            ));
        }

        const sourceBundle = getOwningBundle(sourcePath, bundleRoots);
        if (!sourceBundle) {
            continue;
        }

        for (const reference of collectSerializedUuidReferences(sourcePath, parsedSource)) {
            const target = uuidIndex.get(reference.uuid);
            if (!target || target.bundle === sourceBundle) {
                continue;
            }

            const rule = findForbiddenRule(policy, sourceBundle, target.bundle);
            if (!rule) {
                continue;
            }

            const key = [sourceBundle, target.bundle, sourcePath, reference.controlPath, target.asset, rule.name].join('|');
            if (!violationByKey.has(key)) {
                violationByKey.set(key, {
                    sourceBundle,
                    sourceGroup: policy.bundleToGroup.get(sourceBundle),
                    sourcePath,
                    controlPath: reference.controlPath,
                    targetBundle: target.bundle,
                    targetGroup: policy.bundleToGroup.get(target.bundle),
                    targetAsset: target.asset,
                    rule: rule.name,
                });
            }
        }
    }

    const violations = Array.from(violationByKey.values()).sort((left, right) => (
        left.sourcePath.localeCompare(right.sourcePath)
        || left.controlPath.localeCompare(right.controlPath)
        || left.targetAsset.localeCompare(right.targetAsset)
    ));

    languageDefaultViolations.sort((left, right) => (
        left.sourcePath.localeCompare(right.sourcePath)
        || left.controlPath.localeCompare(right.controlPath)
        || left.component.localeCompare(right.component)
    ));

    if (violations.length === 0) {
        console.log(`源码 Bundle UUID 检查通过：扫描 ${bundleRoots.length} 个 Bundle，建立 ${uuidIndex.size} 个 UUID 索引。`);
    } else {
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
            for (const item of items.sort((left, right) => left.controlPath.localeCompare(right.controlPath))) {
                console.error(`  控件 ${item.controlPath} -> ${projectRelative(projectRoot, item.targetAsset)}`);
            }
            console.error(`命中规则：${first.rule}`);
        }

        console.error('');
        console.error('处理建议：将这些资源移动到允许依赖的公共 Bundle，或者让来源 Prefab 使用自己 Bundle 内的资源。');
    }

    if (languageDefaultViolations.length === 0) {
        if (policy.defaultLanguageBundle) {
            console.log(`多语言默认资源检查通过：LanguageSprite、LanguageSpine 的默认资源为空或来自 ${policy.defaultLanguageBundle}。`);
        }
    } else {
        console.error('');
        console.error('【多语言默认资源检查失败】');
        console.error(`原因：LanguageSprite、LanguageSpine 的默认资源必须为空，或来自默认中文 Bundle「${policy.defaultLanguageBundle}」。`);

        for (const item of languageDefaultViolations) {
            const targetAsset = item.targetAsset
                ? projectRelative(projectRoot, item.targetAsset)
                : `UUID ${item.resourceUuid}（未找到对应的项目资源）`;
            console.error('');
            console.error(`来源文件：${projectRelative(projectRoot, item.sourcePath)}`);
            console.error(`控件路径：${item.controlPath}`);
            console.error(`组件类型：${item.component}`);
            console.error(`资源标识：${item.dataID || '<空>'}`);
            console.error(`当前资源：${targetAsset}`);
            console.error(`当前 Bundle：${item.targetBundle || '<无法识别>'}`);
            console.error(`正确要求：默认资源请留空，或改用 ${policy.defaultLanguageBundle} 中的同名资源。`);
        }

        console.error('');
        console.error('处理建议：在 Cocos Creator 中把对应多语言组件的默认图片或 Spine 改为中文资源后重新保存。');
    }

    const passed = violations.length === 0 && languageDefaultViolations.length === 0;
    if (!passed) {
        console.error('Cocos Creator 尚未启动，本次没有执行构建。');
    }
    return passed;
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
