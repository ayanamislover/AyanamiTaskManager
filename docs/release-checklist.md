# 发布清单

本清单适用于 Windows x64 的 1.0.3 发布。任何红项都必须修复或在 release notes 中明确列为非阻塞剩余项；不得把缺失产物写成“已完成”。

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
- [ ] 11 个 MCP schema 总长度不超过 8 KB

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

- [x] 从干净的构建输入运行最终命令（不删除用户工作树变更）
- [x] 逐项复核哈希和产物可打开
- [x] README、用户指南、Agent 接入、备份恢复和排障文档已同步
- [x] 发布结论只引用 `release/test-report` 中可复核证据

## 1.0.3 非阻塞剩余项

以下六条本轮没有可复核证据，一律保持未勾选。它们在 1.0.2 的清单里是勾上的，但当时同样没有对应用例——即这些勾属于超额声明，本轮按清单自身的规矩改回未验证。功能本身没有已知缺陷，只是没有守卫，因此列为非阻塞。

| 条目                                | 缺口                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| 项目迁移从空库和 v1/v2 数据库均通过 | 用例只覆盖从空库建到当前 schema，没有 v1/v2 旧库的升级路径用例                                   |
| 11 个 MCP schema 总长度不超过 8 KB  | 仓库里没有任何守卫会量这个体积                                                                   |
| `Ctrl+K`、`Ctrl+N` 快捷键           | e2e 覆盖了 `Esc`、焦点圈定与焦点恢复，两个快捷键没有用例                                         |
| 归档→PRE_TRASH→垃圾箱→恢复          | `PRE_TRASH` 只出现在实现里，没有任何用例走完这条链路                                             |
| 托盘、二次启动唤起                  | 同组的自启动开关（packaged smoke）与五类通知（e2e）已覆盖，托盘与 `second-instance` 唤起没有用例 |
| 空闲项目数据库 5 分钟 LRU 关闭      | 用例只验证 `closeIdleProjects` 机制本身（阈值传 0 立即关闭），没有断言 5 分钟这个策略值          |

## 1.0.3 验收结果

十阶段全绿，`output/release-verification.json` 记 `passed: true`：lint 3s、format 2s、typecheck 14s、test 9s（50 文件 111 用例）、e2e 21s（13/13）、benchmark 50s、build 21s、forge-make 67s、packaged-smoke 19s、distribution-smoke 58s（23/23，含 portable 14/14 与 installed 14/14）。

产物 commit `d057445`，Electron 43.3.0 / Node 24.18.1 / SQLite 3.53.4，schema registry 3、project 5。Setup SHA-256 `6BC6D746942ECADE8198A69C459CBC6070C227323FC7434FF19C52F7EFC8CEFC`，portable `9C45A5BAE4CF7A0F0F087FF42588E6F2454431CABFAE78E1850E7EFC97E50814`；四件产物的哈希在装机后用 `Get-FileHash` 重算过，与 `SHA256SUMS.txt` 一致。

安装后对运行实例实测：`/api/v1/system/status` 返回 `version 1.0.3`、`ok true`、`projectCount 9`（即 registry 与 9 个项目库的 `quick_check` 全部通过，用户数据完整穿过卸载重装）。本版修复的四个出口按钮沿按钮自己的 `POST /api/v1/projects/{code}/ui/work-items/patch` 逐个走通：`WAITING_USER→IN_PROGRESS`、`BLOCKED→IN_PROGRESS`、`WAITING_AGENT→IN_PROGRESS`、`VERIFYING→IN_PROGRESS`，且 `blockedReason` 与 `waitingFor` 均被清空。

全部命令退出码、原始 JSON 与截图见 `../release/test-report/`。
