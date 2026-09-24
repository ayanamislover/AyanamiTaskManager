# 便携版与 Agent 接入

直接运行 `AyanamiTaskManager.exe`。关闭窗口后服务继续驻留托盘；使用托盘菜单“完全退出”才会停止服务。

- 健康检查：`AyanamiTaskManager.exe --doctor`
- CLI：`AyanamiTaskManager.exe --cli doctor`
- MCP stdio：建议直接在“设置 → Agent 接入”复制或安装配置。便携版手工配置时，命令指向 `%LOCALAPPDATA%\AyanamiTaskManager\current\resources\atm-mcp.exe`（应用启动时建立的版本无关链接；建不出链接时用解压目录下的 `resources\atm-mcp.exe`），参数为 `--profile core`（另两个 server 分别为 `memory`、`actions`），不需要环境变量
- Streamable HTTP：在应用“设置 → Agent 接入”中复制带本地令牌的配置

数据默认保存在 `%LOCALAPPDATA%\AyanamiTaskManager`，升级或解压新版不会删除数据。备份、恢复、导出和 Agent 配置安装均在应用设置或项目“数据工具”中完成。
