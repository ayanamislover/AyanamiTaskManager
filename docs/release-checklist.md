# 发布清单

本清单适用于 Windows x64 的 1.0.17 发布。任何红项都必须修复或在 release notes 中明确列为非阻塞剩余项；不得把缺失产物写成“已完成”。

勾选一律以 `release/test-report` 里可复核的证据为准：命令退出码、smoke 的逐项 JSON、benchmark 的阈值与实测、以及安装后对运行实例的实测。没有对应证据的条目保持未勾选，并在文末“非阻塞剩余项”里写明缺口。

## 代码与数据门禁

- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] `pnpm test:e2e`
- [x] `pnpm benchmark`
- [x] 项目迁移从空库和 v1/v2 数据库均通过
- [x] Registry 与项目库 `quick_check` 通过
- [x] core 6 / memory 5 两个 MCP Profile 的 UTF-8 schema 各自不超过 7,680 bytes

## 桌面与可访问性

- [x] 1366×768、1920×1080、3440×1440 无关键遮挡或横向截断
- [x] 总览、项目详情、任务抽屉、搜索、保存视图、设置均使用真实 API
- [x] `Ctrl+K`、`Ctrl+N`、`Esc`、Tab/Shift+Tab 焦点圈定与焦点恢复通过
- [x] 归档→PRE_TRASH→垃圾箱→恢复通过
- [x] 工程统计项目级和 WorkItem 级展示通过
- [x] 托盘、二次启动唤起、自启动开关与三档通知策略通过

## 可靠性与性能

- [x] packaged smoke 的健康、native SQLite、项目库、MCP、WebSocket、备份恢复、自启动、退出和重启持久化全部通过
- [x] 100 项目总览 p95 ≤200 ms
- [x] 10,000 任务筛选 p95 ≤200 ms
- [x] 写入+事件 p95 ≤100 ms
- [x] 50,000 中文文档搜索 p95 ≤300 ms
- [x] 服务 RSS ≤150 MB
- [x] 空闲项目数据库 5 分钟 LRU 关闭

### MCP bridge 内存验收

发布前必须用客户端配置中的稳定命令运行：

```powershell
pnpm exec tsx scripts/mcp-bridge-memory.ts --bridges 10 --repeat 3 --settle-ms 3000 --json output/release/mcp-bridge-memory-1.0.17.json
```

2026-08-27 对最终 1.0.17 安装版实测 core Profile：1 个 bridge 为 27.77 MiB Private Bytes；
10 个合计 319.74 MiB；每多 1 个 bridge 的边际为 **32.44 MiB Private Bytes**。三轮系统
可用内存差中位数为 236.29 MiB（23.63 MiB/bridge），但极差 292.38 MiB 已触发噪声拒绝
门槛，因此本次发布结论只引用低噪声的 Private Bytes 边际。含共享映像重复计数的 Working
Set 与本轮系统可用内存差只用于诊断，不作为 bridge 内存成本或运行时优劣结论。

## 构建与安装

一条命令走完升版、十阶段、卸载、安装与实测：

```powershell
pnpm exec tsx scripts/release-and-install.ts --version 1.0.17
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
├─ AyanamiTaskManager-Setup-1.0.17-win-x64.exe
├─ AyanamiTaskManager-1.0.17-win-x64-portable.zip
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
- packaged、portable、installed smoke 各 33 项结果，以及 distribution smoke 19 项结果；
- benchmark 原始阈值与实测；
- 1366/1920/3440 截图；
- installer 与 portable 启动证据；
- 已知非阻塞剩余项，或明确写“无”。

## 签发

- [x] 从干净的构建输入运行最终命令（不删除用户工作树变更）
- [x] 逐项复核哈希和产物可打开
- [x] README、用户指南、Agent 接入、备份恢复和排障文档已同步
- [x] 发布结论只引用 `release/test-report` 中可复核证据

## 1.0.17 非阻塞剩余项

无。此前四条证据缺口已经分别由 v1/v2 迁移夹具、完整归档与垃圾箱恢复链、真实打包窗口生命周期烟测，以及默认 5 分钟边界测试补齐；这些用例均纳入全量测试与发布流水线。

## 勘误

初版本清单把「MCP schema 总长度不超过 8 KB」记为「仓库里没有任何守卫会量这个体积」，是错的：守卫一直在 `packages/mcp/test/mcp.test.ts` 里，只是写作 `8_000` 这个字面量，当时的搜索没命中。该条已改回已验证。

后续复查发现原守卫用 JavaScript 字符数冒充字节数：当时是 8085 个 UTF-16 code unit，实际 UTF-8 序列化为 8311 bytes，已经越过 8192 bytes 目标。现改为 `Buffer.byteLength(..., "utf8")` 的真实字节守卫，并从 8192 bytes 中固定预留 512 bytes；默认字段不再误列为 required，enum 不再重复携带 type，外部校验语义保持不变。早期单 Profile 的“12 个工具、7660 bytes”已经被双 Profile 交付取代：当前 core 6 与 memory 5 名称不重叠，联合为 11 个工具，两个 Profile 分别受 7680-byte 守卫约束；任何一侧吃掉预留余量前就会让测试失败。

## 1.0.17 验收结果

最终候选绑定 Git `57438e27471d30f91dad0421acdaf4816980215f`，release manifest 证明
`dirty=false`，source hash 为 `C545EF326AB9C9EC66C7BF1DF28AE6F01FF8DC56EEB00E7823B76B67796EE703`，
lockfile hash 为 `EDAB7E986CDA4570FB5B3CC80401E88C978172CE49500416C6AD2F69CE7CED5F`。

- Windows 路径身份、status/phase 双写守卫、reconciliation 散文 token 与 settings 驼峰键
  契约修复后，lint、format、typecheck、134 个测试文件 / 451 项测试、benchmark、build、
  forge make 与 packaged smoke 均重新执行；Playwright 14/14 与 distribution 19/19 的输入
  指纹未变，按阶段指纹复用紧邻候选的通过证据。
  portable/installed 各 33/33，安装后六个客户端 Profile 与真实窗口 smoke 另行重跑通过。
- benchmark：冷启动 606.058 ms；100 项目总览 p95 1.041 ms；10,000 任务筛选 p95
  9.975 ms；写入+事件 p95 90.717 ms；增量读取 p95 9.3 ms；50,000 中文搜索 p95
  0.218 ms；服务 RSS 122.91 MB。
- 已安装稳定入口 `%LOCALAPPDATA%\AyanamiTaskManager\current\AyanamiTaskManager.exe`
  自报 1.0.17，`system/status ok=true`，14 个项目库全部通过健康检查。
- Codex、Claude Desktop、Claude Code 的 core 6 + memory 5 六个 Profile 均从稳定入口
  完成握手，工具面不重叠且共享同一安装版 daemon 状态。
- 安装版窗口实测确认 frameless 拖动与控制按钮、抽屉安全区、关闭到托盘、后台启动、二次
  实例恢复；HKCU Run 使用稳定入口与 `--background --random-startup-delay`。
- Setup SHA-256：`E9E002F1A9066B380028D9226DA2D3DC9638A94435133134816910C8E0A46CE3`。
- portable SHA-256：`B7E99DABE43CC11DE54A08578399D3B741E0F7292DE528499CAA2B67E7229B8A`。
- `release.json` SHA-256：`40B863C7B944C602F54D88784C48A28E33E8CB643B0D12B47EECFACF3E35C63A`；
  SBOM SHA-256：`71AA2771E08A2C5D7C92935155CD18BFB704089A17A18CDB48746D7E884FB589`。
