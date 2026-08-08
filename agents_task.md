# Agent 施工进度（最近 15 条）

- 2026-08-07：完成 Registry 保存视图/设置版本化 CRUD 与 REST/client；新增独立 agent-config 适配包，Codex TOML/Claude JSON 最小合并和写前备份 3 用例通过；设置页提供 HTTP/stdio/通用配置、安装/连接测试及备份/通知策略，项目页接入多维保存筛选和 USER provenance 记录页。
- 2026-08-07：可靠性切片完成：启动自动关闭失联 Session、保留 stale claim 显式接管、清理中断 temp、幂等日/周在线备份及可配置保留；项目/全局 WebSocket `since` 断线重放测试无重复跳号；支持 UI 关闭异常 Session/释放过期 claim；MCP `tools/list` 从 11983 字符压至 7827，达到 8KB 目标。
- 2026-08-08：桌面托盘和五类系统通知完成并通过严格类型检查；仓库级 lint/typecheck、38 项全量测试和完整 build 全绿；补齐 `packages/testing` 公共测试工具。
- 2026-08-08：Forge package 真实产出通过：仓库级 hoisted linker、Node-API better-sqlite3 ABI 探针、便携使用说明、独立 stdio 代理；packaged smoke 11 项全绿，覆盖健康/native SQLite/独立库/MCP/WebSocket/备份恢复/自启动/干净退出/重启持久化。
- 2026-08-08：真实 SQLite benchmark 达标：冷启 406ms、100 项目总览 p95 0.212ms、1 万任务筛选 4.35ms、单写+事件 24.975ms、100 delta 0.179ms、5 万中文文档搜索 0.173ms、服务 RSS 119MB；修复 Registry 搜索投影 O(N) 全量重建为增量更新并加回归测试。
- 2026-08-08：完整读取 269 行 95% Closeout 增补（SHA-256 `85F24D1E64F55853C63DA093AFCC18FF7EB9DC0278A4A9C502561FAE7D8C5A04`）；增量加入项目管理密度、工程统计 v1、自举、release/test-report 和只剩非阻塞 5% 的停止条件。
- 2026-08-08：closeout UI 切片完成：项目页补齐健康/进度来源/目标日、当前进行、阻塞等待、Agent/领取、最近更新、READY 下一步及列表管理列；7 个对话层统一 Esc/焦点圈定/恢复；垃圾箱前置备份和 5 分钟项目库 LRU 接通，并修复跨 UTC 日期的自动备份幂等时间戳；lint、全仓 typecheck、3 项定向回归全绿。
- 2026-08-08：Engineering Metrics v1 落地：新增轻量 Git 扫描包、Project DB v3 快照/WorkItem baseline 持久化、任务开始/完成/Session 结束采样、REST/client 与项目/任务 UI；覆盖 Source/Test LOC、文件/依赖、7/30d 净 LOC、最大/高 churn 和任务文件/行/依赖变更；真实 Git 2 项、应用重启 1 项、REST 6 项及全仓 lint/typecheck 全绿。
- 2026-08-08：ATM 自举闭环完成：现有 ATM 项目通过新增受控 path attach API 绑定当前源码；真实创建 ATM-T-0002/0003/0004，Codex Session 完成 claim/start/progress/FACT record/complete/end；第二 Session 退休生成 1 个 handoff，第三 Session 以 predecessor resume 并接手 ATM-T-0003；同时修复 unborn HEAD 工程统计为空树 baseline，3 项扫描测试全绿。
- 2026-08-08：补齐 Agent 接入、用户指南、备份恢复、故障排除、发布清单 5 份文档并将 ADR-015 标记为已实现；Playwright CLI 在 1366/1920/3440 实机浏览器核验项目页、快捷键和对话框行为并留存截图。
- 2026-08-08：新增可重复 Playwright E2E 基础设施和 3 项真实 API/UI 验收；RED 暴露全局搜索焦点恢复缺陷后，将对话框首焦点从 React 提交期 autoFocus 改为统一延迟策略并稳定保存触发者；桌面密度、视图/搜索/保存视图、Esc/焦点圈定/恢复全部 GREEN（3/3）。
- 2026-08-08：1.0.0 发布闭环完成：Forge core API 生成 167.7MB Squirrel Setup 与 173.3MB portable ZIP；修复安装目录/数据目录冲突并真实完成 portable/安装版各 11 项 smoke、静默安装/重启/卸载/数据保留；根 `release/` 含 manifest、SPDX SBOM、四项 SHA-256 和可复核 test-report，43 测试、3 E2E、benchmark、三类 smoke 全绿，最终 lint/typecheck/diff-check 通过；ATM-T-0001～0004 全部 DONE/100%，发布 ON_TRACK 项目更新并以 completed 关闭自举 Session。
- 2026-08-08：按用户要求以 ATM Session `01KZG0T56EDGPQFJDN03JAFR1G` 推进新一轮工作；创建 ATM-T-0005～0008，分别覆盖卡巴斯基删除完整性恢复、网页暗黑主题、端口 9999、简短长期记忆说明与最终验收；ATM-T-0005 已 claim/start。
- 2026-08-08：增量创建 ATM-T-0009（配色一致的无边框本地 EXE）并完成参考图核对；完整性基线进度更新为 55%，确认工作区/依赖/静态检查/43 测试/build/native SQLite/既有发布哈希正常；用户新增初版与完成版 GitHub 双提交要求，登记 ATM-T-0010 推进。
- 2026-08-08：用户要求将过短的进度摘要上限按实际放宽并进行真实 3 子线程 ATM 分工验收；创建 ATM-T-0011，将 progress summary 上限目标定为 500 字并要求 REST/MCP 边界回归；计划在初版 Git 推送后由三线程分别领取暗黑、端口+协议、无边框 EXE。
