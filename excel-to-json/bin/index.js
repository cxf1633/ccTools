#!/usr/bin/env node
const path = require('path')
const fs = require('fs')
const xlsx = require('node-xlsx')
const { writeFileSync, mkdirSync } = require('fs')
const { Command } = require('commander')
const program = new Command()
const { version } = require('../package.json')

// 工具根目录。输入、输出路径都相对于该目录解析，使工具可以独立使用。
const toolRoot = path.resolve(__dirname, '..')

// 读取配置文件中的路径
function loadConfigPaths() {
    const configPath = path.join(__dirname, '../configPaths.txt')
    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = {}

    console.log('工具根目录:', toolRoot)
    
    configContent.split('\n').forEach(line => {
        line = line.trim()
        if (line && !line.startsWith('#')) {
            const [key, value] = line.split('=')
            if (key && value) {
                const fullPath = path.resolve(toolRoot, value.trim())
                config[key.trim()] = fullPath
                console.log(`${key.trim()}: ${fullPath}`)
            }
        }
    })
    
    return config
}

const configPaths = loadConfigPaths()
const frameworkI18nInputPath = configPaths.frameworkI18nInputPath
const frameworkI18nOutputPath = configPaths.frameworkI18nOutputPath
const gameI18nInputPath = configPaths.gameI18nInputPath
const gameI18nOutputPath = configPaths.gameI18nOutputPath
const configInputPath = configPaths.configInputPath
const configOutputPath = configPaths.configOutputPath

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
    const languageColumns = firstRow
        .slice(defaultKeyIndex + 1)
        .map((language, index) => ({
            language,
            columnIndex: defaultKeyIndex + index + 1
        }))
        .filter(item => item.language)
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
        languageColumns.forEach(({ language, columnIndex }) => {
            if (row && row.length) {
                const key = row[columnKeyIndex] || row[defaultKeyIndex]
                let value = row[columnIndex]
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

function writeLanguageJson(result, outputPath) {
    ensureDirectoryExists(outputPath)

    for (const key in result) {
        if (!key) {
            continue
        }

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

function convertLanguageTable(label, inputPath, outputPath) {
    if (!fs.existsSync(inputPath)) {
		console.warn(`警告：${label}不存在，已跳过: ${inputPath}`)
        return
    }

    console.log(`开始处理${label}: ${inputPath}`)
    const jsonData = parseLanguageExcel(inputPath)
    writeLanguageJson(jsonData, outputPath)
    console.log(`✓ ${label}转换完成: ${path.basename(inputPath)} -> ${outputPath}`)
}

/** 配置表类型行中允许出现的数据类型关键字（用于定位类型行，反推列名行与数据起始行）。 */
const CONFIG_TYPE_KEYWORDS = new Set([
    'int', 'integer', 'long', 'float', 'double', 'number',
    'bool', 'boolean', 'str', 'string', 'text', 'array', 'json',
    'date', 'duration', 'obj', 'object', 'map'
])

/** 字段归属行中允许出现的端标记。 */
const SIDE_TOKENS = new Set(['client', 'server', 'all', 'both'])

/** 首列以 "##" 开头的是元信息行（##var / ##type / ## 描述）。 */
function isConfigMetaRow(row) {
    const first = row && row[0]
    return typeof first === 'string' && first.trim().startsWith('##')
}

/** 整行都是类型关键字（A 列的 "##type" 之类标记忽略）。 */
function isConfigTypeRow(row) {
    if (!row || row.length === 0) return false

    let keywordCount = 0
    for (const cell of row) {
        if (cell === undefined || cell === null || cell === '') continue
        if (typeof cell !== 'string') return false
        if (cell.trim().startsWith('##')) continue
        if (!CONFIG_TYPE_KEYWORDS.has(cell.trim().toLowerCase())) return false
        keywordCount++
    }

    return keywordCount >= 2
}

/** 取单元格的端标记（client/server/all/both），不是标记则返回空串。 */
function getScopeToken(cell) {
    if (typeof cell !== 'string') return ''
    const token = cell.trim().toLowerCase()
    return SIDE_TOKENS.has(token) ? token : ''
}

/** key 列之后整行都是端标记的行 = 字段归属行。 */
function isConfigScopeRow(row, keyColumnIndex) {
    if (!row || row.length === 0) return false

    let tokenCount = 0
    for (let c = keyColumnIndex; c < row.length; c++) {
        const cell = row[c]
        if (cell === undefined || cell === null || cell === '') continue
        if (!getScopeToken(cell)) return false
        tokenCount++
    }

    return tokenCount > 0
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

    // ===== 表头识别（按“类型行”锚定，兼容几种表头写法） =====
    // 常见结构（方括号为可选，行数各表略有差异）：
    //   [标题行 / 中文名列]        <- 如 item.xlsx 的“说明”“编号KEY…”行
    //   列名行                     <- 真实字段名；##var 风格表的 A 列是 "##var"
    //   类型行                     <- int / string / array / duration …（用它反推列名行）
    //   [描述行]                   <- 中文说明，A 列通常为 "##"
    //   [server 行 + client 行]    <- 字段归属行，单元格填 client/server/all/both
    //   数据行…
    // 列名行 = 类型行的上一行。本工具服务于客户端工程：
    // 有归属行时只导出 key 列 + 标了 client（或 all/both）的列。
    const headerScanLimit = Math.min(sheetData.length, 12)
    let typeRowIndex = -1
    for (let i = 1; i < headerScanLimit; i++) {
        if (isConfigTypeRow(sheetData[i])) {
            typeRowIndex = i
            break
        }
    }

    // 客户端 / 服务端 字段归属（列索引 -> 是否标记）
    const clientColumnIndexes = new Set()
    const serverColumnIndexes = new Set()
    let hasScopeRow = false
    let nameRow = null
    let keyColumnIndex = 0
    let firstDataRowIndex = 2

    if (typeRowIndex >= 1) {
        // 标准结构：类型行上一行是列名行，归属行在类型行之后
        nameRow = sheetData[typeRowIndex - 1]
        if (!nameRow || nameRow.length === 0) {
            throw new Error('类型行上一行没有列名')
        }
        keyColumnIndex =
            typeof nameRow[0] === 'string' && nameRow[0].trim().startsWith('##') ? 1 : 0

        let lastScopeRowIndex = -1
        const scopeScanEnd = Math.min(sheetData.length, typeRowIndex + 8)
        for (let i = typeRowIndex + 1; i < scopeScanEnd; i++) {
            const row = sheetData[i]
            if (!row || row.length === 0) continue
            if (isConfigMetaRow(row)) continue
            if (!isConfigScopeRow(row, keyColumnIndex)) continue

            hasScopeRow = true
            lastScopeRowIndex = i
            for (let c = keyColumnIndex; c < row.length; c++) {
                const token = getScopeToken(row[c])
                if (!token) continue
                if (token === 'client' || token === 'all' || token === 'both') {
                    clientColumnIndexes.add(c)
                }
                if (token === 'server' || token === 'all' || token === 'both') {
                    serverColumnIndexes.add(c)
                }
            }
        }

        // 有归属行 → 最后一条归属行之后；否则 → 类型行之后跳过多余的 "##" 描述行
        firstDataRowIndex = lastScopeRowIndex >= 0 ? lastScopeRowIndex + 1 : typeRowIndex + 1
        if (lastScopeRowIndex < 0) {
            while (
                firstDataRowIndex < sheetData.length &&
                isConfigMetaRow(sheetData[firstDataRowIndex])
            ) {
                firstDataRowIndex++
            }
        }
    } else {
        // 兜底（老模板，无类型行）：第1行列名，第2行备注，第3行起数据；##var 风格跳过 "##" 行
        nameRow = sheetData[0]
        if (!nameRow || nameRow.length === 0) {
            throw new Error('第一行没有列名')
        }
        const markerStyle =
            typeof nameRow[0] === 'string' && nameRow[0].trim().startsWith('##')
        keyColumnIndex = markerStyle ? 1 : 0
        firstDataRowIndex = markerStyle ? 1 : 2

        while (
            firstDataRowIndex < sheetData.length &&
            isConfigMetaRow(sheetData[firstDataRowIndex])
        ) {
            firstDataRowIndex++
        }

        // 老模板同样支持归属行（紧跟在备注行/元信息行之后）
        for (
            let i = firstDataRowIndex;
            i < Math.min(sheetData.length, firstDataRowIndex + 4);
            i++
        ) {
            const row = sheetData[i]
            if (!isConfigScopeRow(row, keyColumnIndex)) break

            hasScopeRow = true
            firstDataRowIndex = i + 1
            for (let c = keyColumnIndex; c < row.length; c++) {
                const token = getScopeToken(row[c])
                if (!token) continue
                if (token === 'client' || token === 'all' || token === 'both') {
                    clientColumnIndexes.add(c)
                }
                if (token === 'server' || token === 'all' || token === 'both') {
                    serverColumnIndexes.add(c)
                }
            }
        }
    }

    // 跳过数据前的空行
    while (firstDataRowIndex < sheetData.length) {
        const row = sheetData[firstDataRowIndex]
        if (row && row.length > 0) break
        firstDataRowIndex++
    }

    // 有效列：排除空列名与 Notes；有归属行时客户端只导出 key 列 + 标了 client 的列
    const validColumns = []
    for (let i = keyColumnIndex; i < nameRow.length; i++) {
        const rawName = nameRow[i]
        if (rawName === undefined || rawName === null) continue
        const columnName = typeof rawName === 'string' ? rawName.trim() : rawName
        if (columnName === '' || columnName === 'Notes') continue
        if (i === keyColumnIndex) {
            // key 列恒保留（行ID，例如 ID / itemId）
            validColumns.push({ name: columnName, index: i })
            continue
        }
        if (hasScopeRow && !clientColumnIndexes.has(i)) continue

        validColumns.push({ name: columnName, index: i })
    }

    if (validColumns.length === 0) {
        throw new Error('没有找到有效的列（所有列都被跳过或为空）')
    }

    // 初始化结果对象
    const result = {}

    // 从第一条数据行开始处理
    for (let rowIndex = firstDataRowIndex; rowIndex < sheetData.length; rowIndex++) {
        const row = sheetData[rowIndex]

        // 跳过空行
        if (!row || row.length === 0) continue

        // key列为JSON对象的key（模板A取A列，模板B取第一个真实列）
        const key = row[keyColumnIndex]
        if (!key) continue // 跳过没有key的行

        // 处理多列数据
        const rowData = {}
        for (const column of validColumns) {
            if (column.index === keyColumnIndex) continue // 跳过key列

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

        // 尝试转换为数字（严格匹配数字串，避免把 "+86"、"0012"、"-" 等误当数字）
        if (/^-?(\d+(\.\d*)?|\.\d+)$/.test(value)) {
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
    .usage('[options]')
    .action(() => {
        try {
            console.log('开始执行Excel转JSON转换...')
            console.log('当前工作目录:', process.cwd())
            console.log('配置路径:')
            console.log('  frameworkI18nInputPath:', frameworkI18nInputPath)
            console.log('  frameworkI18nOutputPath:', frameworkI18nOutputPath)
            console.log('  gameI18nInputPath:', gameI18nInputPath)
            console.log('  gameI18nOutputPath:', gameI18nOutputPath)
            console.log('  configInputPath:', configInputPath)
            console.log('  configOutputPath:', configOutputPath)
            
            // 框架与游戏语言表分别输出，避免同名语言 JSON 互相覆盖。
            console.log('开始处理多语言表...')
            convertLanguageTable('框架多语言表', frameworkI18nInputPath, frameworkI18nOutputPath)
            convertLanguageTable('游戏多语言表', gameI18nInputPath, gameI18nOutputPath)
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
