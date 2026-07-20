# Cocos Creator 命令行构建工具

项目通过主仓库中的 BAT 入口执行 Web Mobile 构建：

```powershell
.\cocos-build\build-web-mobile.bat
```

Creator 可执行文件路径由项目主仓库的 `cocos-build/tool-config.json` 配置，例如：

```json
{
  "creatorExe": "C:\\ProgramData\\cocos\\editors\\Creator\\3.8.8\\CocosCreator.exe",
  "creatorVersion": "3.8.8",
  "forbiddenBundleDependencies": {
    "hall": ["login", "texasHoldem"],
    "login": ["hall", "texasHoldem"],
    "texasHoldem": ["hall", "login"]
  }
}
```

共享工具本身不保存项目或机器的 Creator 安装路径。不同项目可以维护各自的 `tool-config.json`。

如需临时覆盖配置文件，可通过通用环境变量指定：

```powershell
$env:COCOS_CREATOR_EXE = 'D:\Cocos\Creator\3.8.8\CocosCreator.exe'
.\cocos-build\build-web-mobile.bat
```

也可以直接向 PowerShell 工具传入 `-CreatorExe`；优先级为命令行参数、`COCOS_CREATOR_EXE` 环境变量、`tool-config.json`。

构建产物目录根据项目构建配置中的 `buildPath` 和 `outputName` 自动推导。命令行日志输出到 `temp/builder/log/<outputName>-cli.log`。

脚本启动 Creator 前会临时移除 `ELECTRON_RUN_AS_NODE`。从某些基于 Electron 的终端启动构建时，该环境变量会导致 `CocosCreator.exe` 按 Node.js 方式运行，从而无法识别 Creator 命令行参数。

脚本使用 `Start-Process -Wait -PassThru` 等待 Creator 完整构建结束，再读取真实退出码并执行产物检查，不会把后台仍在运行的构建误报为失败。BAT 和 PowerShell 控制台统一使用 UTF-8，避免 Creator 中文日志按系统 GBK 代码页显示成乱码。

执行脚本前应先保存项目并关闭所有 Cocos Creator 窗口。Creator 使用单实例进程；如果编辑器主进程已经打开，它可能接收命令行参数，但不会把构建退出码返回给调用脚本。脚本只拦截 Creator 主进程，会忽略关闭编辑器后可能残留的 `renderer`、`gpu-process`、`crashpad-handler` 等 Electron 子进程。

Cocos 构建成功后，脚本根据项目 `tool-config.json` 中的 `forbiddenBundleDependencies` 检查业务 Bundle 依赖。共享工具本身不保存任何项目 Bundle 名称。调查现有依赖问题期间，如需临时跳过检查并产出构建包，可执行：

```powershell
.\cocos-build\build-web-mobile.bat -SkipBundleDependencyCheck
```

项目构建配置由主仓库的 `cocos-build/web-mobile.json` 维护。构建面板选项或参与构建的场景发生变化时，应明确更新该文件，不要直接使用编辑器生成的 `profiles/v2/packages/builder.json` 作为命令行配置。
