# 便携版与 Agent 接入

完整解压后直接运行 `AyanamiTaskManager.exe`。关闭窗口后服务继续驻留托盘；使用托盘菜单“完全退出”才会停止服务。

解压目录里的 `portable` 文件是便携版的标记，内容是版本号，不要删除或清空：没有它，程序认不出自己的布局，会拒绝启动；清空后版本会显示成 `dev`。便携版不经安装器，也不做自动更新；换新版本就是解压新的 ZIP。便携版也不注册「保活」计划任务：意外退出后不会自动重新启动，`--cli doctor --offline` 的 `keepalive.auto_recovery` 为 `false`。

- 健康检查：`AyanamiTaskManager.exe --doctor`
- CLI：`AyanamiTaskManager.exe --cli doctor`
- MCP stdio：建议直接在“设置 → Agent 接入”复制或安装配置。便携版手工配置时，命令指向解压目录下的 `resources\atm-mcp.exe`，参数为 `--profile core`（另一个 server 为 `--profile memory`；`actions` 只是旧配置用的 core 别名），不需要环境变量。便携版没有版本无关的 `current` 链接：换到新的解压目录后，应用启动时的配置修复会把已安装的 Agent 配置改到新路径
- Streamable HTTP：在应用“设置 → Agent 接入”中复制带本地令牌的配置

数据默认保存在 `%LOCALAPPDATA%\AyanamiTaskManager3`，与安装版相同；首次运行会把 `%LOCALAPPDATA%\AyanamiTaskManager` 里的 2.x 数据转换过来，旧目录不改。升级或解压新版不会删除数据。备份、恢复、导出和 Agent 配置安装均在应用设置或项目“数据工具”中完成。
