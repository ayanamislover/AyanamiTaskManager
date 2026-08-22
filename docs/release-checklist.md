# 发布清单

本清单适用于 Windows x64 的 1.0.13 发布。任何红项都必须修复或在 release notes 中明确列为非阻塞剩余项；不得把缺失产物写成“已完成”。

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
pnpm exec tsx scripts/release-and-install.ts --version 1.0.13
```

它会先拒绝脏工作树（发布是从工作树打包的，别人未提交的改动会被一起打进产物），
升版本号并校验没有遗漏站点后，先把版本站点与重置后的发布清单提交为
`chore: prepare release <version>`；后续十阶段只接受这个可直接检出同版本的 clean HEAD。
随后清掉同名进程（**包括 MCP stdio 桥**，它们用同一个
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
├─ AyanamiTaskManager-Setup-1.0.13-win-x64.exe
├─ AyanamiTaskManager-1.0.13-win-x64-portable.zip
├─ SHA256SUMS.txt
├─ release.json
├─ sbom.spdx.json
└─ test-report/
```

`SHA256SUMS.txt` 必须覆盖 Setup、portable ZIP、release manifest 和 SBOM。`release.json`
记录版本、平台、构建时间、产物名/大小/哈希和测试报告索引；`source` 节同时固化可检出
同版本的 `gitHead`、`dirty=false`、工作树状态哈希、源码哈希与 lockfile 哈希。assembler
会重新计算这些值，验证报告之后发生任何源码变化都会拒绝组装。SBOM 使用 SPDX JSON。

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

## 1.0.13 非阻塞剩余项

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

## 1.0.13 验收结果

**十阶段 10/10**（9 个执行、benchmark 复用：`stage-inputs-unchanged`）。

- 单元/集成 **196 通过**（68 个文件）；e2e **13 通过 / 0 失败 / 0 flaky**。
- packaged / portable / installed smoke 各 **18/18**（比 1.0.12 多两条，见下）；
  distribution-smoke **19/19**。

| 产物                                             | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `AyanamiTaskManager-Setup-1.0.13-win-x64.exe`    | `769A8B641B0B51E2318506110D6693F01BCB915431F68BB3A9E4B5627A8F3AB5` |
| `AyanamiTaskManager-1.0.13-win-x64-portable.zip` | `A9E1A6E80C63D2E4995C383647C44AB8AF6BB24D8329CFD358FB4DD48045F5B9` |

### 本轮修的（其一）：三轮「已修复」写的都是一份没人读的文件

Claude 桌面版是 Microsoft Store（MSIX）装的。带包身份的应用写 `%APPDATA%` 会被系统
重定向进包容器，**它真正读的是**
`%LOCALAPPDATA%\Packages\Claude_<publisherId>\LocalCache\Roaming\Claude\`。
我们一直只写经典路径，写完读回来一切正常——于是 1.0.10、1.0.11、1.0.12 三轮验证全绿，
而用户机器上那份配置从头到尾没被碰过一次，一直停在 `app-1.0.3`。

这是本轮最贵的一条教训：**「写进去能读回来」不等于「那个应用会读它」。** 验证面必须落在
消费方实际读取的位置上，而不是我们认为它应该在的位置。

`publisherId` 是按发布者证书算出来的哈希，不能写死。改成扫 `Packages` 下所有 `Claude_*`
前缀，父目录存在才算候选，两种形态都在就两份都写。

### 本轮修的（其二）：路径认版本号，就永远要靠别人重读配置

1.0.12 让 `command` 带 `app-<version>`，靠 ATM 启动时把配置改回当前版本兜底。方向没错，
但它**只改得动盘上那份文件**——MCP 客户端在会话开始时把配置读进内存，之后无论盘上怎么
改，那个会话都还拿启动那一刻的路径去 spawn。旧目录被 Squirrel 删掉，用户就看到
`spawn ...pp-1.0.10\AyanamiTaskManager.exe ENOENT`。

改成数据根下一个版本无关的目录链接 `%LOCALAPPDATA%\AyanamiTaskManager\current`
（NTFS junction，**不需要管理员权限**），每次启动重新指向当前安装目录。配置里那行字从此
不再随版本变化，客户端拿多旧的配置都能起来。

不能用 Squirrel 安装根那个启动壳（1.0.11 试过）：它是 GUI launcher，拉起真实 exe 之后
自己就退出（实测 +5542ms、code 0）。junction 没有这个问题——穿透之后就是真实 exe 本身。

**真机验证**（1.0.13 装完后）：

| 项                                        | 结果                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `…\AyanamiTaskManager\current`            | 目录链接，指向 `app-1.0.13`                                               |
| 四份配置的 `command`                      | 全部是 `…\current\AyanamiTaskManager.exe`，**仍钉在某个版本上的 0 份**    |
| 按包容器那份配置原样起进程                | 16 秒全程存活，`initialize` 返回 `ayanami-task-manager 1.0.13`，12 个工具 |
| 空闲 14 秒后再 `tools/list`               | 仍返回 12 个工具                                                          |
| 重启 ATM 前后四份配置的哈希与 `.bak` 份数 | 完全一致——修复是幂等的，不会每启动一次就重写一次                          |

守卫加在 packaged-smoke（因此三种形态各跑一遍）：`command` 必须落在数据根那个链接下、
且不含 `app-<version>` 段。单测另外覆盖「换版本后启动方式一字不变」「已经指对时不重建」
「位置被真目录占住时退开不删」，以及**「递归删掉数据根不会穿透链接删掉安装目录」**——
这条链接指向的是安装根，删除只用 `rmdir`/`unlink`，任何 recursive 删除都会变成删用户的应用。

验红：把 `command` 退回真实 exe，2 条红；拿掉占位守卫，1 条红。

**勾选 28/32**，其余四条见「1.0.13 非阻塞剩余项」，本轮无新增缺口。
