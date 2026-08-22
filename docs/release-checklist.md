# 发布清单

本清单适用于 Windows x64 的 1.0.12 发布。任何红项都必须修复或在 release notes 中明确列为非阻塞剩余项；不得把缺失产物写成“已完成”。

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
pnpm exec tsx scripts/release-and-install.ts --version 1.0.12
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
├─ AyanamiTaskManager-Setup-1.0.12-win-x64.exe
├─ AyanamiTaskManager-1.0.12-win-x64-portable.zip
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

## 1.0.12 非阻塞剩余项

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

## 1.0.12 验收结果

**十阶段 10/10**，执行 168.7 秒、跳过 46.9 秒（benchmark 复用）。

- 单元/集成 **187 通过**（67 个文件）；e2e **13 通过 / 0 失败 / 0 flaky**。
- packaged / portable / installed smoke 各 **16/16**（新增的是「MCP 进程在握手后仍然存活」）；
  distribution-smoke **19/19**。

| 产物                                             | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `AyanamiTaskManager-Setup-1.0.12-win-x64.exe`    | `FDA147BD5138274D184DBBD4509F196E144832555A796DE0C5DC208D71FABA1C` |
| `AyanamiTaskManager-1.0.12-win-x64-portable.zip` | `3690E28186048A4C99526AA983811D0CCBB992780468B82BA73884EF8AA1E26A` |

### 本轮修的：1.0.11 用错了 Squirrel 启动壳

1.0.11 为了让 MCP 配置不带版本号，把 `command` 换成安装根那个启动壳。**那是错的**，
而当时的验证不足以发现它：只验了握手，没验进程寿命。

启动壳是给 GUI 用的 launcher，拉起真实 exe 之后自己就退出。同一份配置下实测：

| 直接子进程      | 结果                                        |
| --------------- | ------------------------------------------- |
| Squirrel 启动壳 | **+5542ms 自行退出 code=0**（stdin 仍打开） |
| 真实 exe        | 12 秒全程存活                               |

握手是成功的——输出经继承的管道回来了——但 MCP 客户端盯的是它直接拉起的那个进程，
它一退客户端就判定 server 挂了。结果是「测着是通的、用起来是断的」，用户每开一次会话
报一次错。**这是同一个缺陷的第二次：1.0.10 那次是只验了「桥能跑」没验「配置里的路径能
跑」，1.0.11 这次是只验了「能握手」没验「能一直活着」。两次都是验收面比真实使用面窄。**

改回真实 exe。`command` 因此重新认版本号，这是有意的取舍，安全性来自 1.0.11 已经加好的
启动时修复，而且链路是自洽的：桥接脚本要读 `runtime/daemon.json` 才能干活，也就是 ATM
必须正在运行，而 ATM 一启动就已经把配置修到自己这一版；Squirrel 也不会删掉正在运行的
那一版。`args` 仍然不认版本。

**真机验证**（1.0.12 装完后）：

- Codex / Claude Desktop / Claude Code 三份配置的 `command` 都已改写为 `app-1.0.12\…exe`，
  `args` 都是数据根那一份，两个路径都真实存在。
- 按配置原样起进程：**15 秒全程存活**，`initialize` 返回 `ayanami-task-manager 1.0.12`，
  空闲 14 秒后再发 `tools/list` 仍返回 12 个工具。
- 配置备份从 34 份收敛到 **5 份**（新加的保留上限）——`command` 认版本意味着每发一版就
  重写三份配置各留一个 `.bak`，不设上限会一直堆下去。

守卫补在了会真正拦住它的地方：packaged-smoke 现在直接用 `mcpLaunch` 的产出（不再自己拼
路径），并单独验一条进程寿命（保持 stdin 打开、9 秒后必须还活着）。验红：把 `command`
改回启动壳，该检查报「在 +5561ms 就退出了」。

**勾选 28/32**，其余四条见「1.0.12 非阻塞剩余项」，本轮无新增缺口。
