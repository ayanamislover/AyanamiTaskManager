# ADR-003：Electron Main 承载常驻服务

状态：Superseded by [ADR-016](./ADR-016-native-host.md)（原生宿主 + 系统 WebView2）。以下为当时的决定，保留作历史记录。

领域与应用服务保持无 Electron 依赖，生产环境由 Electron Main 承载 Fastify、数据库管理器、托盘、自启动和窗口；daemon 入口用于独立测试。选择 Electron 是因为规格要求 Windows 桌面、托盘、登录启动、原生通知与单实例，而浏览器壳无法完成这些最终能力。
