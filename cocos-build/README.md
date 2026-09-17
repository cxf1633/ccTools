# Cocos Creator 命令行构建工具

## Android

`build-android.js` 保存共享打包实现，项目入口和配置保留在各自主仓库。直接调用示例：

```powershell
node tools/cocos-build/build-android.js --project-root . --config cocos-build/build-config-android.json --tool-config cocos-build/tool-config.json --check
```

`--project-root` 默认为当前工作目录，两个配置路径相对于项目目录解析。项目 BAT 应传入绝对路径，以支持从任意目录启动。项目中的中文入口为 `cocos-build/打安卓包.bat`，Web 入口为 `cocos-build/打网页包.bat`。

Android 支持 `--mode debug|release`、`--skip-cocos`、`--creator`、`--java-home`。源码和构建产物依赖检查均使用同目录的 `check-bundle-dependencies.js`。

项目 `tool-config.json` 可设置 `android.apkNameTemplate` 和 `android.apkOutputDirectory`：模板支持 `{index}`（从 1 开始）、`{version}`、`{originalName}`（含 .apk）、`{mode}`；默认模板为 `{index}-v{version}-{originalName}`。输出目录默认为项目下的 `build/apk`，每次构建创建北京时间精确到分钟的子目录，同分钟重复构建自动加序号。APK、日志和耗时记录都保存在该目录。

共享实现属于 `tools` 子模块；提交时先提交子模块改动，再在主仓库提交入口、配置和子模块引用。

## Web Mobile

项目通过主仓库中的 BAT 入口执行 Web Mobile 构建：

```powershell
.\cocos-build\打网页包.bat
```

构建规则由项目主仓库的 `cocos-build/tool-config.json` 配置，例如：

```json
{
  "creatorVersion": "3.8.8",
  "bundleGroups": {
    "base": ["internal", "resources"],
    "shared": ["components", "language"],
    "entry": ["main"],
    "feature": ["login", "hall", "texasHoldem"]
  },
  "forbiddenBundleDependencies": [
    {
      "name": "base 组的 internal、resources 不可依赖任何其他 bundle",
      "fromGroup": "base",
      "toGroup": "*"
    },
    {
      "name": "shared 组的 components、language 不可依赖 entry 和 feature",
      "fromGroup": "shared",
      "toGroups": ["entry", "feature"]
    },
    {
      "name": "entry 组的 main 不可依赖 feature",
      "fromGroup": "entry",
      "toGroup": "feature"
    },
    {
      "name": "feature 组的 login、hall、texasHoldem 不可依赖 entry，也不可互相依赖",
      "fromGroup": "feature",
      "toGroups": ["entry", "feature"]
    }
  ],
  "unknownBundlePolicy": "error"
}
```

共享工具本身不保存任何项目或机器的配置，`creatorExe`、`creatorVersion` 和 Bundle 分组都由各项目的 `tool-config.json` 提供。

如需临时覆盖配置文件，可通过通用环境变量指定：

```powershell
$env:COCOS_CREATOR_EXE = 'D:\Cocos\Creator\3.8.8\CocosCreator.exe'
.\cocos-build\打网页包.bat
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

规则通过 `fromGroup` 指定来源分组，通过 `toGroup` 或 `toGroups` 指定禁止依赖的目标分组；目标 `*` 表示禁止依赖任何分组。`name` 只用于报错显示和违规去重，不参与匹配判断，不能为空，可直接写成中文说明。`unknownBundlePolicy` 为 `error` 时，源码或构建产物中未登记到任何分组的 Bundle 也会导致检查失败。共享工具本身不保存任何项目 Bundle 名称。

调查现有依赖问题期间，如需临时跳过源码 UUID 和构建产物 `deps` 两层检查并产出构建包，可执行：

```powershell
.\cocos-build\打网页包.bat -SkipBundleDependencyCheck
```

项目构建配置由主仓库的 `cocos-build/web-mobile.json` 维护。构建面板选项或参与构建的场景发生变化时，应明确更新该文件，不要直接使用编辑器生成的 `profiles/v2/packages/builder.json` 作为命令行配置。

各配置文件的逐字段说明见主仓库的 `cocos-build/README.md`。
