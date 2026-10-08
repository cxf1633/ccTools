const fs = require('fs')
const path = require('path')

const scriptDirectory = __dirname
const projectRoot = path.resolve(scriptDirectory, '..', '..')
const configFile = path.join(scriptDirectory, 'sync-language-paths.txt')

function readConfig(filePath) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`找不到配置文件：${filePath}`)
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
            throw new Error(`配置格式错误：${rawLine}`)
        }

        const key = line.slice(0, separatorIndex).trim()
        let value = line.slice(separatorIndex + 1).trim()
        if (!value) {
            throw new Error(`配置值不能为空：${key}`)
        }

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1)
        }

        config[key] = value
    }

    return config
}

function resolveConfigPath(configuredPath) {
    return path.isAbsolute(configuredPath)
        ? path.resolve(configuredPath)
        : path.resolve(projectRoot, configuredPath)
}

function getLanguageJsonFiles(label, sourceDirectory) {
    if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
        throw new Error(`${label}源目录不存在：${sourceDirectory}`)
    }

    const files = fs.readdirSync(sourceDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json')
        .map(entry => path.join(sourceDirectory, entry.name))
        .sort((left, right) => left.localeCompare(right))

    if (files.length === 0) {
        throw new Error(`${label}源目录中没有 JSON 文件：${sourceDirectory}`)
    }

    return files
}

function copyGameLanguages(files, targetRoot) {
    for (const sourceFile of files) {
        const fileName = path.basename(sourceFile)
        const language = path.basename(sourceFile, path.extname(sourceFile))
        const targetDirectory = path.join(targetRoot, language)
        const targetFile = path.join(targetDirectory, fileName)

        fs.mkdirSync(targetDirectory, { recursive: true })
        fs.copyFileSync(sourceFile, targetFile)
        console.log(`[游戏] ${sourceFile} -> ${targetFile}`)
    }
}

function syncLanguages() {
    const config = readConfig(configFile)
    const requiredKeys = ['gameSourceDir', 'gameTargetDir']

    for (const key of requiredKeys) {
        if (!config[key]) {
            throw new Error(`配置文件缺少字段：${key}`)
        }
    }

    const gameSourceDir = resolveConfigPath(config.gameSourceDir)
    const gameTargetDir = resolveConfigPath(config.gameTargetDir)

    const gameFiles = getLanguageJsonFiles('游戏多语言', gameSourceDir)

    copyGameLanguages(gameFiles, gameTargetDir)

    console.log(`游戏多语言同步完成：${gameFiles.length} 个。`)
}

try {
    syncLanguages()
} catch (error) {
    console.error(`多语言同步失败：${error.message}`)
    process.exitCode = 1
} finally {
    console.log('')
    console.log('按任意键关闭窗口...')
}
