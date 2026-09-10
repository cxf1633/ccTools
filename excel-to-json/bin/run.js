#!/usr/bin/env node
// 转表启动入口：先确保依赖已安装，再执行 bin/index.js
// 注意：本文件只能使用 Node 内置模块，因为它要在 node_modules 还不存在时就能跑起来。
const path = require('path')
const { spawnSync } = require('child_process')

const toolDir = path.join(__dirname, '..')
// index.js 实际用到的运行时依赖
const REQUIRED_DEPS = ['node-xlsx', 'commander']

function findMissingDeps() {
    return REQUIRED_DEPS.filter(dep => {
        try {
            require.resolve(dep)
            return false
        } catch (error) {
            return true
        }
    })
}

function installDeps() {
    console.log('[提示] 首次运行：检测到依赖缺失，正在执行 npm install，需要联网，只需执行一次...')
    console.log('')
    const result = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: toolDir,
        stdio: 'inherit',
        shell: true
    })
    return result.status === 0
}

function printInstallHelp() {
    console.error('')
    console.error(`[错误] 依赖安装失败，请在 ${toolDir} 目录下手动执行：npm install`)
    console.error('       如果没有 npm 命令，请先安装 Node.js 16 或更高版本：https://nodejs.org/')
    console.error('       如果是网络问题，可改用国内镜像源：')
    console.error('       npm install --registry=https://registry.npmmirror.com')
}

const missingDeps = findMissingDeps()

if (missingDeps.length === 0) {
    require('./index.js')
} else {
    if (!installDeps()) {
        printInstallHelp()
        process.exit(1)
    }

    const stillMissing = findMissingDeps()
    if (stillMissing.length > 0) {
        console.error('')
        console.error(`[错误] npm install 已执行，但仍找不到模块：${stillMissing.join('、')}`)
        printInstallHelp()
        process.exit(1)
    }

    console.log('')
    console.log('[提示] 依赖安装完成，开始转表。')
    console.log('')

    // 依赖是本次进程运行中才装好的，用新进程执行转表，避免模块解析缓存问题
    const result = spawnSync(process.execPath, [path.join(__dirname, 'index.js')].concat(process.argv.slice(2)), {
        stdio: 'inherit'
    })
    process.exit(typeof result.status === 'number' ? result.status : 1)
}
