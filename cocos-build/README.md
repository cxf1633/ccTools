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
  "bundleGroups": {
    "base": ["internal", "resources"],
    "shared": ["components", "language"],
    "entry": ["main"],
    "feature": ["login", "hall", "texasHoldem"]
  },
  "forbiddenBundleDependencies": [
    {
      "name": "base-must-not-depend-on-other-bundles",
      "fromGroup": "base",
      "toGroup": "*"
    },
    {
      "name": "shared-must-not-depend-on-entry-or-feature",
      "fromGroup": "shared",
      "toGroups": ["entry", "feature"]
    },
    {
      "name": "entry-must-not-depend-on-feature",
      "fromGroup": "entry",
      "toGroup": "feature"
    },
    {
      "name": "feature-must-not-depend-on-entry-or-feature",
      "fromGroup": "feature",
      "toGroups": ["entry", "feature"]
    }
  ],
  "unknownBundlePolicy": "error"
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

Bundle 检查由 `check-bundle-dependencies.js` 执行，因此运行环境需要在 `PATH` 中提供 `node.exe`。Node.js 直接以 UTF-8 输出中文，并通过退出码通知 PowerShell 停止流程，不会附带 PowerShell 异常调用栈。

检查器根据项目 `tool-config.json` 中的 `bundleGroups` 和 `forbiddenBundleDependencies` 执行两层检查：

1. 启动 Creator 前扫描源码中的资源 UUID 引用，阻止 Prefab、Scene、Animation、Material 等资源跨越禁止的 Bundle 分组边界。该检查不受 Bundle 优先级影响，因此同优先级 Bundle 复制共享资源时也能发现原始违规引用。
2. Cocos 构建成功后读取各 Bundle 的 `config*.json`，继续检查最终生成的 `deps`。

源码检查会从目录 `.meta` 的 `userData.isBundle` 和 `userData.bundleName` 自动发现 Bundle 根目录，并建立主资源及 SpriteFrame 等子资源的 UUID 索引。对于 Prefab 等 Cocos 序列化资源，检查器会通过组件的 `node.__id__` 解析完整控件路径；报错信息包含来源文件、控件路径、目标资源和命中的规则。

同一来源文件中的违规引用会按来源 Bundle 和目标 Bundle 合并显示。

规则通过 `fromGroup` 指定来源分组，通过 `toGroup` 或 `toGroups` 指定禁止依赖的目标分组；目标 `*` 表示禁止依赖任何分组。`unknownBundlePolicy` 为 `error` 时，源码或构建产物中未登记到任何分组的 Bundle 也会导致检查失败。共享工具本身不保存任何项目 Bundle 名称。

调查现有依赖问题期间，如需临时跳过源码 UUID 和构建产物 `deps` 两层检查并产出构建包，可执行：

```powershell
.\cocos-build\build-web-mobile.bat -SkipBundleDependencyCheck
```

项目构建配置由主仓库的 `cocos-build/web-mobile.json` 维护。构建面板选项或参与构建的场景发生变化时，应明确更新该文件，不要直接使用编辑器生成的 `profiles/v2/packages/builder.json` 作为命令行配置。
