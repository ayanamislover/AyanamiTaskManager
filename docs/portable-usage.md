# 便携版与 Agent 接入

完整解压后直接运行 `AyanamiTaskManager.exe`。关闭窗口后服务继续驻留托盘；使用托盘菜单“完全退出”才会停止服务。

解压目录里的 `portable` 空文件是便携版的标记，不要删除：没有它，程序认不出自己的布局，会拒绝启动。便携版不经安装器，也不做自动更新；换新版本就是解压新的 ZIP。

- 健康检查：`AyanamiTaskManager.exe --doctor`
- CLI：`AyanamiTaskManager.exe --cli doctor`
- MCP stdio：建议直接在“设置 → Agent 接入”复制或安装配置。便携版手工配置时，命令指向解压目录下的 `resources\atm-mcp.exe`，参数为 `--profile core`（另两个 server 分别为 `memory`、`actions`），不需要环境变量。便携版没有版本无关的 `current` 链接：换到新的解压目录后，应用启动时的配置修复会把已安装的 Agent 配置改到新路径
- Streamable HTTP：在应用“设置 → Agent 接入”中复制带本地令牌的配置

数据默认保存在 `%LOCALAPPDATA%\AyanamiTaskManager`，升级或解压新版不会删除数据。备份、恢复、导出和 Agent 配置安装均在应用设置或项目“数据工具”中完成。
