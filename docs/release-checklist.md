# 发布清单

本清单适用于 Windows x64 的 1.0.10 发布。任何红项都必须修复或在 release notes 中明确列为非阻塞剩余项；不得把缺失产物写成“已完成”。

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
- [x] `Ctrl+K`、`Ctrl+N`、`Esc`、Tab/Shift+Tab 焦点圈定与焦点恢复通过
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

一条命令走完升版、十阶段、卸载、安装与实测：

```powershell
pnpm exec tsx scripts/release-and-install.ts --version 1.0.10
```

它会先拒绝脏工作树（发布是从工作树打包的，别人未提交的改动会被一起打进产物），
升版本号后校验没有遗漏站点，清掉同名进程（**包括 MCP stdio 桥**，它们用同一个
exe 名且占着安装目录句柄），跑完十阶段，静默安装，最后启动并核对运行实例自报的
版本号。加 `--skip-install` 只跑到产出 `release/`。

必须在能真实写入 `%LOCALAPPDATA%` 的终端里跑——Agent 的 Bash 通道对该路径的
创建会落进只有它自己看得见的覆盖层，安装看起来成功、实际没落盘；PowerShell
通道与真实磁盘一致（ATM-R-067）。

分步执行时：

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
├─ AyanamiTaskManager-Setup-1.0.10-win-x64.exe
├─ AyanamiTaskManager-1.0.10-win-x64-portable.zip
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

## 1.0.10 非阻塞剩余项

以下四条至今没有可复核证据，一律保持未勾选。它们在 1.0.2 及更早的清单里是勾上的，但仓库里始终没有对应用例——即那些勾属于超额声明，自 1.0.3 起按清单自身的规矩改回未验证。功能本身没有已知缺陷，只是没有守卫，因此列为非阻塞。

| 条目                                | 缺口                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| 项目迁移从空库和 v1/v2 数据库均通过 | 用例只覆盖从空库建到当前 schema，没有 v1/v2 旧库的升级路径用例                                   |
| 归档→PRE_TRASH→垃圾箱→恢复          | `PRE_TRASH` 只出现在实现里，没有任何用例走完这条链路                                             |
| 托盘、二次启动唤起                  | 同组的自启动开关（packaged smoke）与五类通知（e2e）已覆盖，托盘与 `second-instance` 唤起没有用例 |
| 空闲项目数据库 5 分钟 LRU 关闭      | 用例只验证 `closeIdleProjects` 机制本身（阈值传 0 立即关闭），没有断言 5 分钟这个策略值          |

## 勘误

初版本清单把「MCP schema 总长度不超过 8 KB」记为「仓库里没有任何守卫会量这个体积」，是错的：守卫一直在 `packages/mcp/test/mcp.test.ts` 里，只是写作 `8_000` 这个字面量，当时的搜索没命中。该条已改回已验证。

同时记下一次有意的放宽：加入第 12 个工具 `atm_checklist`（471 字节）后总长 8085，超过原先钉的 `8_000`，因此把守卫对齐到本清单一直写着的 8 KB（8192 字节）。这不是把标准改到能过——文档要求的一直是 8 KB——但它确实吃掉了原有 192 字节的余量，下一个工具再进来时预算就真的紧了。

## 1.0.10 验收结果

一条命令 `pnpm exec tsx scripts/release-and-install.ts --version 1.0.10` 全程由 Agent 在
PowerShell 通道跑完，**十阶段 10/10**。本轮改动碰了 `scripts/`，正落在 distribution-smoke
的依赖集内，因此按规则退回完整清场；e2e 与 benchmark 判为 `stage-inputs-unchanged` 复用，
执行 146.8 秒、跳过 69.9 秒。阶段判定逐条记在 `release/test-report/release-verification.json`
的 `stages` 字段，`summary.md` 里也逐行标了出处。

- 单元/集成 **169 通过**（流水线跑时的数量；此后本轮又补进 4 条守卫，仓库现为 66 个文件
  **173 通过**）；e2e **13 通过 / 0 失败 / 0 flaky**（复用）。
- packaged / portable / installed smoke 各 **14/14**；distribution-smoke **19/19**，
  卸载状态 `removed`。
- benchmark 全部低于阈值（复用上一轮实测）：冷启动 **535.146 ms**（≤3000）、
  总览 p95 **1.107 ms**（≤200）、10,000 项筛选 p95 **7.327 ms**（≤200）、
  写入+事件 p95 **27.024 ms**（≤100）、delta 100 事件 **15.169 ms**（≤100）、
  50,000 中文文档搜索 p95 **0.208 ms**（≤300）、服务 RSS **123.8 MB**（≤150）。

产物哈希为本机独立复算，体积与 1.0.6 完全一致（asar 100.9 MiB）：

| 产物                                             | 大小      | SHA-256                                                            |
| ------------------------------------------------ | --------- | ------------------------------------------------------------------ |
| `AyanamiTaskManager-Setup-1.0.10-win-x64.exe`    | 162.8 MiB | `D30F7974419F1865A44EEF72E4F1F7845A8E2F47133C72225C4FACE30BD0D560` |
| `AyanamiTaskManager-1.0.10-win-x64-portable.zip` | 167.4 MiB | `3A163698A8C5550E477D49B5AA5E3C6F6D99833B4A3037B6451E568B78CD1C0C` |

**对装机版实测**：安装目录 `app-1.0.10`，`system/status` 报 `version=1.0.10`、`ok=true`、
`projectCount=10`；开始菜单与桌面快捷方式由应用自己创建。

### 自更新实测（1.0.9 → 这一轮之前的那次）

「旧版跑着、发新版、应用自更新」这条到 1.0.9 才真正实测。做法是只把 1.0.9 的
`RELEASES` 与 nupkg 投进 `%LOCALAPPDATA%\AyanamiTaskManager\updates`，**不运行 Setup、
也不运行 `Update.exe --update`**，然后重启运行中的 1.0.8：

- 2 秒内出现 `app-1.0.9`（114 个文件、447.9 MB、exe ProductVersion 1.0.9），与 `app-1.0.8`
  结构一致；
- 此时进程仍是 `app-1.0.8\AyanamiTaskManager.exe`，`system/status` 报 1.0.8——正是设计的
  「下次启动生效」语义；
- `Squirrel-CheckForUpdate.log` 留下 `--checkForUpdate C:\Users\ayanami\AppData\Local\AyanamiTaskManager\updates`，
  是应用自己发起的；
- 再重启，进程变为 `app-1.0.9\AyanamiTaskManager.exe`，报 1.0.9。

轮询间隔是 6 小时，另在每次启动检查一次。已经开着不动的窗口最长要等 6 小时才发现新版，
重启则立刻发现——单机自用够了，但这是它的实际行为，不是「立即推送」。

### 本轮发现并当场修复

| 问题                                                                                          | 提交      |
| --------------------------------------------------------------------------------------------- | --------- |
| distribution-smoke 只验 Squirrel 卸载注册项，装完开始菜单空空如也照样全绿（1.0.5 的真实故障） | `9165b45` |
| 阶段依赖前缀只写到包一级，改一个 vitest 单测就作废 e2e——省时间的设计被自己的粗粒度抵消        | `82c1a7a` |
| feed 里旧 nupkg 无人清理，跑到 1.0.9 已堆到 647 MB，其中 485 MB 是 RELEASES 没提到的死重      | `3b0e295` |
| 发布报告把复用阶段写成本轮通过，且「已知非阻塞剩余项」是写死的“无”，而清单里一直列着四条      | 本次提交  |

**勾选 28/32**，其余四条见「1.0.10 非阻塞剩余项」，与 1.0.6 相同，本轮没有新增缺口。
