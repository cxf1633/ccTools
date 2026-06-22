#!/usr/bin/env node
const path = require('path')
const fs = require('fs')
const xlsx = require('node-xlsx')
const { writeFileSync, mkdirSync } = require('fs')
const { Command } = require('commander')
const program = new Command()
const { version } = require('../package.json')

// 获取项目根目录（脚本所在目录的上级目录的上级目录的上级目录）
const projectRoot = path.join(__dirname, '../../../')
const FRAMEWORK_I18N_INPUT_PATH = path.resolve(projectRoot, 'assets/framework/tools/i18n/FrameworkI18n.xlsx')
const FRAMEWORK_I18N_OUTPUT_PATH = path.resolve(projectRoot, 'assets/framework/language/json')

// 读取配置文件中的路径
function loadConfigPaths() {
    const configPath = path.join(__dirname, '../configPaths.txt')
    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = {}

    console.log('项目根目录:', projectRoot)
    
    configContent.split('\n').forEach(line => {
        line = line.trim()
        if (line && !line.startsWith('#')) {
            const [key, value] = line.split('=')
            if (key && value) {
                const fullPath = path.resolve(projectRoot, value.trim())
                config[key.trim()] = fullPath
                console.log(`${key.trim()}: ${fullPath}`)
            }
        }
    })
    
    return config
}

const configPaths = loadConfigPaths()
const gameI18nInputDir = configPaths.gameI18nInputDir
const gameI18nOutputPath = configPaths.gameI18nOutputPath
const configInputPath = configPaths.configInputPath
const configOutputPath = configPaths.configOutputPath

const go = (langPath, outputPath = null) => {
    const jsonData = parseLanguageExcel(langPath)
    writeLanguageJson(jsonData, outputPath || gameI18nOutputPath)
}

const parseLanguageExcel = (langPath) => {
    const workbook = xlsx.parse(langPath)
    const sheet = workbook.find(item => item.name === `Sheet1`)
    if (!sheet) {
        throw new Error(`语言表缺少Sheet1: ${langPath}`)
    }

    return packageJsonData(sheet, {}, path.basename(langPath))
}

const packageJsonData = (sheet, options, sourceName = '') => {
    if (sheet.data.length === 0) {
        throw new Error(`sheet is empty: ${sourceName}`)
    }

    const sheetDataList = sheet.data
    const firstRow = sheetDataList[0]
    const defaultKey = 'key'
    const columnKey = options.clunmKey || defaultKey
    const foundKeyIndex = firstRow.findIndex(key => key === columnKey)
    const defaultKeyIndex = foundKeyIndex >= 0 ? foundKeyIndex : 0
    const languages = firstRow.slice(defaultKeyIndex + 1) // depends on key name
    const columnKeyIndex = firstRow.findIndex(item => item === columnKey)

    console.log('firstRow', firstRow)
    console.log('columnKeyIndex', columnKeyIndex)
    console.log('key is ', firstRow[columnKeyIndex])

    const beginRowNum = options.beginRowNum || 1
    let endRowNum = options.endRowNum || sheetDataList.length
    const jsonData = {}
    endRowNum =
        endRowNum > sheetDataList.length ? sheetDataList.length : endRowNum

    for (let i = beginRowNum; i < endRowNum; i++) {
        const row = sheetDataList[i]
        languages.forEach((language, index) => {
            if (row && row.length) {
                const languageIndex = index + defaultKeyIndex + 1
                const key = row[columnKeyIndex] || row[defaultKeyIndex]
                let value = row[languageIndex]
                if (typeof value === 'string') {
                    value = value.replace(/\\n/g, `\n`)
                }
                if (!jsonData[language]) {
                    jsonData[language] = {}
                }
                if (key) {
                    if (Object.prototype.hasOwnProperty.call(jsonData[language], key)) {
                        throw new Error(`重复多语言Key: ${key} (${language}) in ${sourceName}`)
                    }
                    jsonData[language][key] = value || ''
                }
            }
        })
    }

    return jsonData
}

function mergeLanguageJson(target, source, sourceName) {
    for (const language in source) {
        if (!Object.prototype.hasOwnProperty.call(source, language)) {
            continue
        }

        if (!target[language]) {
            target[language] = {}
        }

        const sourceLanguageData = source[language]
        for (const key in sourceLanguageData) {
            if (!Object.prototype.hasOwnProperty.call(sourceLanguageData, key)) {
                continue
            }

            if (Object.prototype.hasOwnProperty.call(target[language], key)) {
                throw new Error(`重复多语言Key: ${key} (${language}) in ${sourceName}`)
            }

            target[language][key] = sourceLanguageData[key]
        }
    }
}

function writeLanguageJson(result, outputPath) {
    ensureDirectoryExists(outputPath)

    for (const key in result) {
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            const element = result[key]
            writeFileSync(
                `${outputPath}/${key}.json`,
                JSON.stringify(element, null, 4)
            )
        }
    }

    console.log(
        `language excel to json finished, output path is ${outputPath}`
    )
}

function getExcelFilesFromDir(dirPath) {
    if (!dirPath || !fs.existsSync(dirPath)) {
        return []
    }

    if (!fs.statSync(dirPath).isDirectory()) {
        return []
    }

    return fs.readdirSync(dirPath)
        .filter(file => file.endsWith('.xlsx') && !file.startsWith('~$'))
        .map(file => path.join(dirPath, file))
}

function convertGameLanguageTables() {
    const excelFiles = getExcelFilesFromDir(gameI18nInputDir)
    if (excelFiles.length === 0) {
        console.log(`警告: 游戏多语言目录中没有找到Excel文件: ${gameI18nInputDir}`)
        return
    }

    const mergedJson = {}
    excelFiles.forEach(filePath => {
        console.log(`开始处理游戏多语言表: ${filePath}`)
        const jsonData = parseLanguageExcel(filePath)
        mergeLanguageJson(mergedJson, jsonData, path.basename(filePath))
    })

    writeLanguageJson(mergedJson, gameI18nOutputPath)
    console.log(`✓ 游戏多语言表转换完成: ${excelFiles.length}个文件 -> ${gameI18nOutputPath}`)
}

function convertFrameworkLanguageTable() {
    if (!fs.existsSync(FRAMEWORK_I18N_INPUT_PATH)) {
        console.log(`警告: 框架多语言表文件不存在: ${FRAMEWORK_I18N_INPUT_PATH}`)
        return
    }

    console.log(`开始处理框架多语言表: ${FRAMEWORK_I18N_INPUT_PATH}`)
    const jsonData = parseLanguageExcel(FRAMEWORK_I18N_INPUT_PATH)
    writeLanguageJson(jsonData, FRAMEWORK_I18N_OUTPUT_PATH)
    console.log(`✓ 框架多语言表转换完成: ${path.basename(FRAMEWORK_I18N_INPUT_PATH)} -> ${FRAMEWORK_I18N_OUTPUT_PATH}`)
}

function parseExcelToJson(filePath) {
    // 解析Excel文件
    const sheets = xlsx.parse(filePath)

    if (sheets.length === 0) {
        throw new Error('Excel文件中没有工作表')
    }

    // 获取第一个工作表的数据
    const sheetData = sheets[0].data

    if (sheetData.length === 0) {
        throw new Error('工作表中没有数据')
    }

    // 获取列名（第一行）
    const columnNames = sheetData[0]
    if (!columnNames || columnNames.length === 0) {
        throw new Error('第一行没有列名')
    }

    // 过滤掉Notes列，并记录有效列的索引
    const validColumns = []
    for (let i = 0; i < columnNames.length; i++) {
        const columnName = columnNames[i]
        if (columnName && columnName !== 'Notes') {
            validColumns.push({
                name: columnName,
                index: i
            })
        }
    }

    if (validColumns.length === 0) {
        throw new Error('没有找到有效的列（所有列都被跳过或为空）')
    }

    // 初始化结果对象
    const result = {}

    // 从第三行开始处理数据（跳过列名行和备注行）
    for (let rowIndex = 2; rowIndex < sheetData.length; rowIndex++) {
        const row = sheetData[rowIndex]
        
        // 跳过空行
        if (!row || row.length === 0) continue

        // 第一列为key
        const key = row[0]
        if (!key) continue // 跳过没有key的行

        // 处理多列数据
        const rowData = {}
        for (const column of validColumns) {
            if (column.index === 0) continue // 跳过key列

            const value = row[column.index]
            // 尝试自动识别并转换数据类型
            rowData[column.name] = autoConvertValue(value)
        }

        result[key] = rowData
    }

    return result
}

/**
 * 自动转换值的类型
 * @param {*} value - 原始值
 * @returns {*} 转换后的值
 */
function autoConvertValue(value) {
    if (value === null || value === undefined) {
        return null
    }

    // 如果是字符串类型，尝试进一步处理
    if (typeof value === 'string') {
        // 去除首尾空格
        value = value.trim()

        // 尝试解析为JSON
        if (isPotentialJSON(value)) {
            try {
                return JSON.parse(value)
            } catch (e) {
                // 解析失败则保持原样
            }
        }

        // 尝试转换为数字
        if (!isNaN(value) && value !== '') {
            return Number(value)
        }

        // 尝试转换为布尔值
        if (value.toLowerCase() === 'true') return true
        if (value.toLowerCase() === 'false') return false
    }

    return value
}

/**
 * 判断字符串是否可能是JSON
 * @param {string} str - 待检查字符串
 * @returns {boolean}
 */
function isPotentialJSON(str) {
    return (
        (str.startsWith('{') && str.endsWith('}')) ||
        (str.startsWith('[') && str.endsWith(']'))
    )
}

/**
 * 确保目录存在，如果不存在则创建
 * @param {string} dirPath - 目录路径
 */
function ensureDirectoryExists(dirPath) {
    try {
        if (!fs.existsSync(dirPath)) {
            mkdirSync(dirPath, { recursive: true })
        }
    } catch (error) {
        console.error(`创建目录失败: ${dirPath}`, error)
        throw error
    }
}

program
    .version(version, '-V, --version')
    .usage('--sourceFile <dir>')
    .option('-s, --sourceFile <dir>', 'source file path need to be converted')
    .action(options => {
        try {
            console.log('开始执行Excel转JSON转换...')
            console.log('当前工作目录:', process.cwd())
            console.log('配置路径:')
            console.log('  gameI18nInputDir:', gameI18nInputDir)
            console.log('  gameI18nOutputPath:', gameI18nOutputPath)
            console.log('  FRAMEWORK_I18N_INPUT_PATH:', FRAMEWORK_I18N_INPUT_PATH)
            console.log('  FRAMEWORK_I18N_OUTPUT_PATH:', FRAMEWORK_I18N_OUTPUT_PATH)
            console.log('  configInputPath:', configInputPath)
            console.log('  configOutputPath:', configOutputPath)
            
            // 处理多语言表
            console.log('开始处理多语言表...')
            convertGameLanguageTables()
            convertFrameworkLanguageTable()
            console.log('多语言表处理完成')

            
            // 批量处理configInputPath目录下的所有Excel文件
            if (fs.existsSync(configInputPath)) {
                if (fs.statSync(configInputPath).isDirectory()) {
                    // 如果是目录，批量处理所有xlsx文件
                    const files = fs.readdirSync(configInputPath)
                    const excelFiles = files.filter(file => file.endsWith('.xlsx'))
                    
                    if (excelFiles.length === 0) {
                        console.log(`目录 ${configInputPath} 中没有找到Excel文件`)
                    } else {
                        console.log(`找到 ${excelFiles.length} 个Excel文件，开始批量转换...`)
                        
                        excelFiles.forEach(file => {
                            const inputFile = path.join(configInputPath, file)
                            const outputFile = path.join(configOutputPath, file.replace('.xlsx', '.json'))
                            
                            try {
                                const jsonData = parseExcelToJson(inputFile)
                                // 确保输出目录存在
                                const outputDir = path.dirname(outputFile)
                                ensureDirectoryExists(outputDir)
                                // 将结果写入JSON文件
                                writeFileSync(outputFile, JSON.stringify(jsonData, null, 4))
                                console.log(`✓ 转换完成: ${file} -> ${path.basename(outputFile)}`)
                            } catch (error) {
                                console.error(`✗ 转换失败: ${file}`, error.message)
                            }
                        })
                        
                        console.log(`批量转换完成，输出目录: ${configOutputPath}`)
                    }
                } else {
                    console.log(`警告: ${configInputPath} 不是目录，跳过处理`)
                }
            }

        } catch (error) {
            console.error('执行过程中发生错误:', error)
            process.exit(1)
        }
    })

program.parse()
