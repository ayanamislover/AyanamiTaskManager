# 发布清单

本清单适用于 Windows x64 的 1.0.15 发布。任何红项都必须修复或在 release notes 中明确列为非阻塞剩余项；不得把缺失产物写成“已完成”。

勾选一律以 `release/test-report` 里可复核的证据为准：命令退出码、smoke 的逐项 JSON、benchmark 的阈值与实测、以及安装后对运行实例的实测。没有对应证据的条目保持未勾选，并在文末“非阻塞剩余项”里写明缺口。

## 代码与数据门禁

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm test:e2e`
- [ ] `pnpm benchmark`
- [ ] 项目迁移从空库和 v1/v2 数据库均通过
- [ ] Registry 与项目库 `quick_check` 通过
- [ ] 12 个 MCP schema 的 UTF-8 序列化体积不超过 8 KB，并预留 512 bytes

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

一条命令走完升版、十阶段、卸载、安装与实测：

```powershell
pnpm exec tsx scripts/release-and-install.ts --version 1.0.15
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

- [ ] Squirrel Setup EXE 可安装到当前用户
- [ ] 安装版可首次启动、退出、重启并保留数据
- [ ] 卸载不误删用户项目数据
- [ ] portable ZIP 解压后可启动
- [ ] packaged stdio MCP 可完成 initialize、tools/list 和一次只读调用
- [ ] `docs/portable-usage.md` 随包存在

`distribution-smoke` 要求机器上没有同名安装、没有运行中的同名进程、没有卸载注册项、没有产品快捷方式。注意 **MCP stdio 桥接进程用的是同一个 `AyanamiTaskManager.exe` 镜像名**：只要还有 Claude 会话连着 ATM，`appProcessIsRunning()` 就成立，验收会停在“没有运行中的应用进程”，而且这些桥还占着安装目录里的 exe 句柄，Squirrel 卸载只能留下 `.dead` 标记。发布前先断开所有连着 ATM 的会话。

## 最终目录

```text
release/
├─ AyanamiTaskManager-Setup-1.0.15-win-x64.exe
├─ AyanamiTaskManager-1.0.15-win-x64-portable.zip
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

- [ ] 从干净的构建输入运行最终命令（不删除用户工作树变更）
- [ ] 逐项复核哈希和产物可打开
- [ ] README、用户指南、Agent 接入、备份恢复和排障文档已同步
- [ ] 发布结论只引用 `release/test-report` 中可复核证据

## 1.0.15 非阻塞剩余项

无。此前四条证据缺口已经分别由 v1/v2 迁移夹具、完整归档与垃圾箱恢复链、真实打包窗口生命周期烟测，以及默认 5 分钟边界测试补齐；这些用例均纳入全量测试与发布流水线。

## 勘误

初版本清单把「MCP schema 总长度不超过 8 KB」记为「仓库里没有任何守卫会量这个体积」，是错的：守卫一直在 `packages/mcp/test/mcp.test.ts` 里，只是写作 `8_000` 这个字面量，当时的搜索没命中。该条已改回已验证。

后续复查发现原守卫用 JavaScript 字符数冒充字节数：当时是 8085 个 UTF-16 code unit，实际 UTF-8 序列化为 8311 bytes，已经越过 8192 bytes 目标。现改为 `Buffer.byteLength(..., "utf8")` 的真实字节守卫，并从 8192 bytes 中固定预留 512 bytes；默认字段不再误列为 required，enum 不再重复携带 type，外部校验语义保持不变。当前 12 个工具为 7660 bytes，可用阈值 7680 bytes；任何新增字段在吃掉预留余量前就会让测试失败。

## 1.0.15 验收结果

本轮尚未完成，结果待填。在十阶段跑完并对安装版实测之前，此处不得写入任何数字。
