# Tools

cocos creator项目工具模块

## excel-to-json

Excel 转 JSON 工具，用于把项目内的多语言表和普通配置表导出为 JSON。

- 工具目录：`tools/excel-to-json`
- 使用说明：`tools/excel-to-json/使用说明.md`
- 转表入口：`excel/转表.bat`（转表 + 把框架多语言自动输出到 `assets/framework/language/json`）
- 游戏多语言表目录：`excel/language`
- 框架多语言表：`excel/language/FrameworkI18n.xlsx`，输出目录配置在 `excel/framework-i18n-output.txt`

游戏多语言、配置表进工程走 `syncConfig/同步配置表.bat`，说明见 `syncConfig/README.md`。

## check_ui_button_handlers.js

UI 按钮同名回调自检工具：扫描 prefab 里挂了 `cc.Button` / 项目 `UIButton` 的节点，和它所属 UI 类的方法名对一遍，
把"界面上有按钮、代码里没有同名函数"（`UIBase` 只按节点名绑，这种情况点了没反应、控制台也不报错）列出来。

- 完整用法与判定规则见脚本头部注释：`node tools/check_ui_button_handlers.js --help`
- 常用：`node tools/check_ui_button_handlers.js --path=HoldemMain --all`（看某个界面每个按钮归谁管）
- 总览：`node tools/check_ui_button_handlers.js --summary`
- 提交前 / CI：`node tools/check_ui_button_handlers.js --path=<界面关键字> --strict`（有缺失时退出码 1）
- 默认只扫 `assets/script/app/UIConfigData.ts` 里登记的 UI 界面，模板 / 格子预制体不会误报；
  动态列表项、滑块把手这些由代码绑的按钮仍可能出现在名单里，配合 `--all` 一起看再判断。
