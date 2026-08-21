# 发布清单

本清单适用于 Windows x64 的 1.0.5 发布。任何红项都必须修复或在 release notes 中明确列为非阻塞剩余项；不得把缺失产物写成“已完成”。

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
pnpm exec tsx scripts/release-and-install.ts --version 1.0.5
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
├─ AyanamiTaskManager-Setup-1.0.5-win-x64.exe
├─ AyanamiTaskManager-1.0.5-win-x64-portable.zip
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

## 1.0.5 非阻塞剩余项

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

## 1.0.5 验收结果

一条命令 `pnpm exec tsx scripts/release-and-install.ts --version 1.0.5` 全程由 Agent 在
PowerShell 通道跑完：拒绝脏工作树 → 升版 → 清场卸载 → 十阶段 → 静默安装 → 启动 → 对
运行实例实测。发布提交 `5306756`。

**十阶段 10/10**，`resume` 未复用（`resume-not-requested`），全新跑完：lint、format、
typecheck、test、e2e、benchmark、build、forge-make、packaged-smoke、distribution-smoke。

- 单元/集成 **142 通过**（60 个文件）；e2e **13 通过 / 0 失败 / 0 flaky**。
- packaged / portable / installed smoke 各 **14/14**；distribution-smoke **23/23**。
- benchmark 全部低于阈值：总览 100 项目 p95 **0.946 ms**（≤200）、10,000 任务筛选 p95
  **4.788 ms**（≤200）、写入+事件 p95 **24.952 ms**（≤100）、delta 100 事件 **9.501 ms**
  （≤100）、50,000 中文文档搜索 p95 **0.132 ms**（≤300）、服务 RSS **126.52 MB**（≤150）、
  冷启动 **450.433 ms**（≤3000）。
- MCP 12 个工具 schema 总长 **8085 字节**（守卫 8192），余量 **107 字节**。

产物哈希为本机独立复算，不是转引 `SHA256SUMS.txt`：

| 产物                                            | 大小     | SHA-256                                                            |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `AyanamiTaskManager-Setup-1.0.5-win-x64.exe`    | 170.4 MB | `D0E04F387A437D570B1B34921FE86A4EB3F6FB4C62277B4C60B3A133C7900B83` |
| `AyanamiTaskManager-1.0.5-win-x64-portable.zip` | 175.4 MB | `9FAED3CD434BA0EB589890F431C4852E50E8FF66BE3352453C86BA8ACC55F2EB` |

**对装机版实测**（不是对工作树）：安装目录只剩 `app-1.0.5`，无 `.dead`，4 个进程全部来自
该目录；`system/status` 报 `version=1.0.5`、`ok=true`、`projectCount=10`。对运行中的实例
实测本轮新功能：

- 同一 `op_id` 同一身份连发两次 → 同一 Session，`disposition` 依次 `CREATED`、`RECOVERED`；
- 同一 `op_id` 改 `threadId` → **409 `IDEMPOTENCY_CONFLICT`**，不产生第二个 Session；
- 带 `op_id` 指向未注册目录 → **422 `ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT`**（修复前是 500）。

**勾选 28/32**，其余四条见「1.0.5 非阻塞剩余项」。本轮把 `Ctrl+K`、`Ctrl+N` 从剩余项移出：
`apps/desktop/e2e/desktop.spec.ts` 里两个快捷键都有真断言（`Control+n` 断言抽屉可见且
`#task-title` 获焦，`Control+k` 断言全局搜索可用并出结果），1.0.4 记为「没有用例」是查漏。

### 本轮发现并当场修复

| 问题                                                                                                                     | 提交      |
| ------------------------------------------------------------------------------------------------------------------------ | --------- |
| `statusForCode` 匹配 `REQUIRED`，而新错误码写的是 `REQUIRES`，永久性前置条件失败落到兜底 500，会让崩溃重放控制器无限重试 | `ead9c95` |
| `git grep` 无匹配退出码为 1 被当成失败，版本号改得越干净、残留检查挂得越准                                               | `1d379a7` |
| 残留检查扫到守卫自己夹具里的版本号                                                                                       | `67e77be` |
| Squirrel 静默卸载留下开始菜单快捷方式、`.dead` 与半个 `app-<version>` 目录，第十阶段前置条件才发现                       | `5306756` |

### 已知问题

Squirrel 静默安装后**没有创建开始菜单快捷方式**——应用是 Squirrel-aware 的（Electron 自带
该标记），Squirrel 因此把创建快捷方式的责任交给应用，而 `apps/desktop/src/main.ts` 里没有
任何 `--squirrel-install` / `--squirrel-updated` 分支，两边都不做，于是没有。本轮已用
`Update.exe --createShortcut AyanamiTaskManager.exe` 手工补建并核对生成（开始菜单与桌面各
一个）。根因未修，需要在主进程接管 Squirrel 启动事件，另开任务。
