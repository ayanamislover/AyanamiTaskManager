# 发布清单

本清单适用于 Windows x64 的 1.0.4 发布。任何红项都必须修复或在 release notes 中明确列为非阻塞剩余项；不得把缺失产物写成“已完成”。

勾选一律以 `release/test-report` 里可复核的证据为准：命令退出码、smoke 的逐项 JSON、benchmark 的阈值与实测、以及安装后对运行实例的实测。没有对应证据的条目保持未勾选，并在文末“非阻塞剩余项”里写明缺口。

## 代码与数据门禁

- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] `pnpm test:e2e`
- [x] `pnpm benchmark`
- [ ] 项目迁移从空库和 v1/v2 数据库均通过
- [x] Registry 与项目库 `quick_check` 通过
- [x] 12 个 MCP schema 总长度不超过 8 KB

## 桌面与可访问性

- [x] 1366×768、1920×1080、3440×1440 无关键遮挡或横向截断
- [x] 总览、项目详情、任务抽屉、搜索、保存视图、设置均使用真实 API
- [ ] `Ctrl+K`、`Ctrl+N`、`Esc`、Tab/Shift+Tab 焦点圈定与焦点恢复通过
- [ ] 归档→PRE_TRASH→垃圾箱→恢复通过
- [x] 工程统计项目级和 WorkItem 级展示通过
- [ ] 托盘、二次启动唤起、自启动开关与五类通知通过

## 可靠性与性能

- [x] packaged smoke 的健康、native SQLite、项目库、MCP、WebSocket、备份恢复、自启动、退出和重启持久化全部通过
- [x] 100 项目总览 p95 ≤200 ms
- [x] 10,000 任务筛选 p95 ≤200 ms
- [x] 写入+事件 p95 ≤100 ms
- [x] 50,000 中文文档搜索 p95 ≤300 ms
- [x] 服务 RSS ≤150 MB
- [ ] 空闲项目数据库 5 分钟 LRU 关闭

## 构建与安装

```powershell
pnpm make
pnpm smoke:packaged
pnpm exec tsx scripts/assemble-release.ts
```

- [x] Squirrel Setup EXE 可安装到当前用户
- [x] 安装版可首次启动、退出、重启并保留数据
- [x] 卸载不误删用户项目数据
- [x] portable ZIP 解压后可启动
- [x] packaged stdio MCP 可完成 initialize、tools/list 和一次只读调用
- [x] `docs/portable-usage.md` 随包存在

`distribution-smoke` 要求机器上没有同名安装、没有运行中的同名进程、没有卸载注册项、没有产品快捷方式。注意 **MCP stdio 桥接进程用的是同一个 `AyanamiTaskManager.exe` 镜像名**：只要还有 Claude 会话连着 ATM，`appProcessIsRunning()` 就成立，验收会停在“没有运行中的应用进程”，而且这些桥还占着安装目录里的 exe 句柄，Squirrel 卸载只能留下 `.dead` 标记。发布前先断开所有连着 ATM 的会话。

## 最终目录

```text
release/
├─ AyanamiTaskManager-Setup-1.0.4-win-x64.exe
├─ AyanamiTaskManager-1.0.4-win-x64-portable.zip
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

- [x] 从干净的构建输入运行最终命令（不删除用户工作树变更）
- [x] 逐项复核哈希和产物可打开
- [x] README、用户指南、Agent 接入、备份恢复和排障文档已同步
- [x] 发布结论只引用 `release/test-report` 中可复核证据

## 1.0.4 非阻塞剩余项

以下五条至今没有可复核证据，一律保持未勾选。它们在 1.0.2 及更早的清单里是勾上的，但仓库里始终没有对应用例——即那些勾属于超额声明，自 1.0.3 起按清单自身的规矩改回未验证。功能本身没有已知缺陷，只是没有守卫，因此列为非阻塞。

| 条目                                | 缺口                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| 项目迁移从空库和 v1/v2 数据库均通过 | 用例只覆盖从空库建到当前 schema，没有 v1/v2 旧库的升级路径用例                                   |
| `Ctrl+K`、`Ctrl+N` 快捷键           | e2e 覆盖了 `Esc`、焦点圈定与焦点恢复，两个快捷键没有用例                                         |
| 归档→PRE_TRASH→垃圾箱→恢复          | `PRE_TRASH` 只出现在实现里，没有任何用例走完这条链路                                             |
| 托盘、二次启动唤起                  | 同组的自启动开关（packaged smoke）与五类通知（e2e）已覆盖，托盘与 `second-instance` 唤起没有用例 |
| 空闲项目数据库 5 分钟 LRU 关闭      | 用例只验证 `closeIdleProjects` 机制本身（阈值传 0 立即关闭），没有断言 5 分钟这个策略值          |

## 勘误

初版本清单把「MCP schema 总长度不超过 8 KB」记为「仓库里没有任何守卫会量这个体积」，是错的：守卫一直在 `packages/mcp/test/mcp.test.ts` 里，只是写作 `8_000` 这个字面量，当时的搜索没命中。该条已改回已验证。

同时记下一次有意的放宽：加入第 12 个工具 `atm_checklist`（471 字节）后总长 8085，超过原先钉的 `8_000`，因此把守卫对齐到本清单一直写着的 8 KB（8192 字节）。这不是把标准改到能过——文档要求的一直是 8 KB——但它确实吃掉了原有 192 字节的余量，下一个工具再进来时预算就真的紧了。

## 1.0.4 验收结果

十阶段全绿，`output/release-verification.json` 记 `passed: true`：lint 2s、format 2s、typecheck 12s、test 9s（54 文件 120 用例）、e2e 20s（13/13）、benchmark 45s、build 20s、forge-make 60s、packaged-smoke 8s、distribution-smoke 62s。冒烟逐项：distribution 28/28、portable 14/14、installed 14/14、packaged 14/14。

产物 commit `55fdc60`，Electron 43.3.0 / Node 24.18.1 / SQLite 3.53.4。Setup 169.9 MB、SHA-256 `53ADE8B545E942C68057373965C41A9E1B13991D69163B2BB9A3ED3183A205C5`；portable 174.9 MB、SHA-256 `56D8C0308DFFFC46078E08D977C0452885532984143DFFAF76377934A290BEC2`。四件产物的哈希在装机后用 `Get-FileHash` 重算过，与 `SHA256SUMS.txt` 一致。

安装后对运行实例实测：`/api/v1/system/status` 返回 `version 1.0.4`、`ok true`，11 个项目完好穿过卸载重装。MCP over HTTP 的 `tools/list` 返回 12 个工具、`atm_checklist` 在列、schema 总长 8059 字节（预算 8192）。本版修复的 blocker 出路在装机版上跑通整条：带 `blocker` 的 `progress` → `BLOCKED`，`complete` 报 `COMPLETION_GATE_FAILED: blocker active`，`reopen` → `IN_PROGRESS` 并解除，`complete` → `DONE`（ATM-T-0077）。1.0.3 上第三步是死路。

**本轮由 Agent 全自动完成**：退出应用与 MCP 桥、Squirrel 静默卸载、十阶段流水线、安装、启动、REST 实测，全部在 PowerShell 通道执行，用户未介入任何一步。此前认为「装进 `%LOCALAPPDATA%` 再运行的验收 Agent 一律做不了」只对 Bash 通道成立——Bash 对该路径的**创建**落进只有它自己可见的覆盖层（删除却穿透），PowerShell 与真实磁盘一致。详见 ATM-R-067。

全部命令退出码、原始 JSON 与截图见 `../release/test-report/`。
