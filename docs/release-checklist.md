# 发布清单

本清单适用于 Windows x64 的 1.0.3 发布。任何红项都必须修复或在 release notes 中明确列为非阻塞剩余项；不得把缺失产物写成“已完成”。

## 代码与数据门禁

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm test:e2e`
- [ ] `pnpm benchmark`
- [ ] 项目迁移从空库和 v1/v2 数据库均通过
- [ ] Registry 与项目库 `quick_check` 通过
- [ ] 11 个 MCP schema 总长度不超过 8 KB

## 桌面与可访问性

- [ ] 1366×768、1920×1080、3440×1440 无关键遮挡或横向截断
- [ ] 总览、项目详情、任务抽屉、搜索、保存视图、设置均使用真实 API
- [ ] `Ctrl+K`、`Ctrl+N`、`Esc`、Tab/Shift+Tab 焦点圈定与焦点恢复通过
- [ ] 归档→PRE_TRASH→垃圾箱→恢复通过
- [ ] 工程统计项目级和 WorkItem 级展示通过
- [ ] 托盘、二次启动唤起、自启动开关与五类通知通过

## 可靠性与性能

- [ ] packaged smoke 的健康、native SQLite、项目库、MCP、WebSocket、备份恢复、自启动、退出和重启持久化全部通过
- [ ] 100 项目总览 p95 ≤200 ms
- [ ] 10,000 任务筛选 p95 ≤200 ms
- [ ] 写入+事件 p95 ≤100 ms
- [ ] 50,000 中文文档搜索 p95 ≤300 ms
- [ ] 服务 RSS ≤150 MB
- [ ] 空闲项目数据库 5 分钟 LRU 关闭

## 构建与安装

```powershell
pnpm make
pnpm smoke:packaged
pnpm exec tsx scripts/assemble-release.ts
```

- [ ] Squirrel Setup EXE 可安装到当前用户
- [ ] 安装版可首次启动、退出、重启并保留数据
- [ ] 卸载不误删用户项目数据
- [ ] portable ZIP 解压后可启动
- [ ] packaged stdio MCP 可完成 initialize、tools/list 和一次只读调用
- [ ] `docs/portable-usage.md` 随包存在

## 最终目录

```text
release/
├─ AyanamiTaskManager-Setup-1.0.3-win-x64.exe
├─ AyanamiTaskManager-1.0.3-win-x64-portable.zip
├─ SHA256SUMS.txt
├─ release.json
├─ sbom.spdx.json
└─ test-report/
```

`SHA256SUMS.txt` 必须覆盖 Setup、portable ZIP、release manifest 和 SBOM。`release.json` 记录版本、平台、构建时间、Git 状态、产物名/大小/哈希和测试报告索引。SBOM 使用 SPDX JSON。

## test-report 最小内容

- 单元/集成/E2E 总结与退出码；
- packaged smoke 的 11 项结果；
- benchmark 原始阈值与实测；
- 1366/1920/3440 截图；
- installer 与 portable 启动证据；
- 已知非阻塞剩余项，或明确写“无”。

## 签发

- [ ] 从干净的构建输入运行最终命令（不删除用户工作树变更）
- [ ] 逐项复核哈希和产物可打开
- [ ] README、用户指南、Agent 接入、备份恢复和排障文档已同步
- [ ] 发布结论只引用 `release/test-report` 中可复核证据

本次 1.0.3 验收结果见 `../release/test-report/summary.md`；全部命令退出码、原始 JSON 与截图均随发布目录保留。
