#!/usr/bin/env node
/**
 * 把框架多语言的转表结果自动输出到工程内的配置目录。
 *
 * 源目录：转表工具 configPaths.txt 里的 frameworkI18nOutputPath（默认 excel/export/framework）
 * 目标目录：本脚本参数指定的配置文件里的 frameworkI18nOutputDir（默认 excel/framework-i18n-output.txt），
 *           相对工程根目录解析，也可以填绝对路径。
 *
 * 用法：node bin/publish-framework-i18n.js [配置文件路径]
 */
const path = require('path')
const fs = require('fs')

// tools/excel-to-json -> 工程根目录
const toolRoot = path.resolve(__dirname, '..')
const projectRoot = path.resolve(toolRoot, '..', '..')
const toolConfigFile = path.join(toolRoot, 'configPaths.txt')
const outputConfigFile = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(projectRoot, 'excel', 'framework-i18n-output.txt')

/** 读取 key=value 文本配置（# 开头为注释，值可以用引号包起来）。 */
function readKeyValueFile(filePath, label) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`找不到${label}：${filePath}`)
    }

    const config = {}
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
    for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) {
            continue
        }

        const separatorIndex = line.indexOf('=')
        if (separatorIndex <= 0) {
            throw new Error(`${label}格式错误（应为 key=value）：${rawLine}`)
        }

        const key = line.slice(0, separatorIndex).trim()
        let value = line.slice(separatorIndex + 1).trim()
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1)
        }

        if (!value) {
            throw new Error(`${label}的 ${key} 不能为空`)
        }

        config[key] = value
    }

    return config
}

function resolveProjectPath(configuredPath) {
    return path.isAbsolute(configuredPath)
        ? path.resolve(configuredPath)
        : path.resolve(projectRoot, configuredPath)
}

/** 源目录：取转表工具自己的配置，保证与工具的输出位置始终一致。 */
function getSourceDir() {
    const toolConfig = readKeyValueFile(toolConfigFile, '转表工具配置 configPaths.txt')
    if (!toolConfig.frameworkI18nOutputPath) {
        throw new Error(`转表工具配置缺少 frameworkI18nOutputPath：${toolConfigFile}`)
    }

    return path.resolve(toolRoot, toolConfig.frameworkI18nOutputPath)
}

function getJsonFileNames(directory) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
        return []
    }

    return fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json')
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right))
}

function publish() {
    const outputConfig = readKeyValueFile(outputConfigFile, '框架多语言输出配置')
    const outputDirValue = outputConfig.frameworkI18nOutputDir
    if (!outputDirValue) {
        throw new Error(`框架多语言输出配置缺少 frameworkI18nOutputDir：${outputConfigFile}`)
    }

    const sourceDir = getSourceDir()
    const targetDir = resolveProjectPath(outputDirValue)

    if (path.resolve(sourceDir) === path.resolve(targetDir)) {
        console.log(`框架多语言源目录与输出目录相同，无需输出：${targetDir}`)
        return
    }

    const fileNames = getJsonFileNames(sourceDir)
    if (fileNames.length === 0) {
        throw new Error(`没有找到框架多语言转表结果：${sourceDir}（请先执行转表）`)
    }

    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true })
    }

    console.log(`框架多语言转表结果：${sourceDir}`)
    console.log(`输出到工程：${targetDir}`)

    for (const fileName of fileNames) {
        fs.copyFileSync(path.join(sourceDir, fileName), path.join(targetDir, fileName))
        console.log(`[输出] ${fileName}`)
    }

    console.log('')
    console.log(`框架多语言输出完成：${fileNames.length} 个文件 -> ${outputDirValue}`)
}

try {
    publish()
} catch (error) {
    console.error(`框架多语言输出失败：${error.message}`)
    process.exitCode = 1
}
