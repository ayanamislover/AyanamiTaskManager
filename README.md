<div align="center">
  <img src="./logo.png" width="128" alt="AyanamiTaskManager logo" />
  <h1>绫波任务管理器</h1>
  <p><strong>让 Codex、Claude 与每一次开发 Session，共享同一份可信项目事实。</strong></p>
  <p>Local-first tasks, handoffs and shared knowledge for AI agents on Windows.</p>

  <p>
    <a href="https://github.com/ayanamislover/AyanamiTaskManager/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/ayanamislover/AyanamiTaskManager?style=flat-square&label=stable&color=7c5ce7" /></a>
    <a href="https://github.com/ayanamislover/AyanamiTaskManager/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ayanamislover/AyanamiTaskManager/actions/workflows/ci.yml/badge.svg?branch=main" /></a>
    <img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%2F%2011-2d2838?style=flat-square" />
    <a href="./LICENSE"><img alt="AGPL-3.0-only" src="https://img.shields.io/badge/license-AGPL--3.0--only-7c5ce7?style=flat-square" /></a>
  </p>

  <p>
    <a href="https://github.com/ayanamislover/AyanamiTaskManager/releases/latest"><strong>下载稳定版</strong></a>
    ·
    <a href="./docs/user-guide.md">用户指南</a>
    ·
    <a href="./docs/agent-integration.md">Agent 接入</a>
    ·
    <a href="./docs/security-model.md">安全模型</a>
    ·
    <a href="./docs/local-knowledge.md">共享知识库</a>
  </p>
</div>

<br />

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/screenshot-project-dark.png" />
    <img src="./docs/assets/screenshot-project-light.png" alt="ATM 项目页：当前进行、阻塞与等待、Agent 与领取、下一步四个面板，以及数据投影状态" width="100%" />
  </picture>
  <p><sub>示例数据：结构取自真实项目，字面内容已全部重写。可用 <code>pnpm exec tsx scripts/render-readme-screenshot.ts</code> 复现。</sub></p>
</div>

---

Agent 写代码不难，难的是**换一次 Session 就忘了项目到哪儿了**。上下文被压缩、进程重启、换个 Agent 接手——项目历史只活在聊天记录里，于是每次开工都要重新翻一遍，翻完还未必翻对。

AyanamiTaskManager（ATM）把计划、任务、进度、阻塞、长期记录、证据和 Session 交接收进一个稳定的事实源，Agent 开工时读一份 brief 就能接着干。它不是另一份待办清单，也不保存整段对话，只保留真正会影响项目推进的结构化事实。桌面 UI、MCP、CLI 与本地 HTTP 共用同一套事务应用服务——你在界面上看到的，和 Agent 读到的，永远是同一份数据。

## 1.1.5 · 知识能完整读回，交接更稳

这一轮聚焦知识工作流的可靠性：**合法内容读得全，保存重试不重复，长历史也能找到最初的版本。**

- **大元数据也能完整回读。** 长来源、标签和适用条件按固定修订分页返回，编辑前能拿到完整内容，不把截断预览当成原文覆盖。
- **会话结束，已成功的写入仍可安全重试。** 完全相同的原请求返回原回执；新操作仍需要活动会话，不会复活已关闭 Session。
- **编辑不再被慢响应覆盖。** 保存过程中锁定竞争入口；标签连续输入保留分隔符，修订历史可翻页，满 30 条来源的导出导入仍能保存。
- **历史列表更轻。** SQLite 先去掉不需要的正文再返回历史；新回执引用不可变修订，避免重复保存大正文。
- **实时连接有明确退路。** 增量发送串行补齐，异常、发送超时和断开清理均有回归覆盖；慢客户端可按已处理序号重新连接。

保留 Agent 直接发布知识和原有桌面设计，不增加逐篇人工审批。升级前请保留备份；如需退回不支持紧凑回执的旧版本，应恢复对应备份。查看[审计修复与验收说明](./docs/audit-1.1.4-remediation.md)；正式发布状态和制品证据以 [GitHub Release](https://github.com/ayanamislover/AyanamiTaskManager/releases) 为准。

### 共享知识库 · 让经验跨项目复用

**项目事实留在项目里，通用知识按需读取。** 本地共享知识库独立于项目数据库；项目归档后，已经发布的知识修订仍可引用。

- **先筛选，再读正文。** `atm_knowledge_search` 返回摘要、使用场景和适用范围；`atm_knowledge_get` 再读取选中条目或指定章节。不把整库塞进开工 brief。
- **引用不随编辑漂移。** 使用不可变的 `id@revisionId`，正文可按字符预算分页读取；条目修改后，旧修订仍有自己的身份。
- **Agent 直接沉淀，不用手工搬运。** MCP 可检索、读取、发布和更新共享知识，自动记录会话作者、固定修订与防覆盖基线；桌面端仍可管理、归档和导入／导出。参考资料不授予新的执行权限。

同时改进了 Session 身份与角色恢复、批量操作 ACK 的最终版本回执、幂等请求一致性，以及启动和长正文读取的开销。安装包携带更新后的 Agent Guide、完整文档与 `atm-knowledge` Skill。

查看[知识库使用说明](./docs/local-knowledge.md) · [版本与下载](https://github.com/ayanamislover/AyanamiTaskManager/releases)。正式发布状态以 Release 页面为准。

## 为什么需要 ATM

| 能力             | ATM 提供的结果                                                                       |
| ---------------- | ------------------------------------------------------------------------------------ |
| **一份事实源**   | 目标、里程碑、叶子 WorkItem、依赖、验收标准与证据始终一致；界面和 Agent 读同一份数据 |
| **Agent 原生**   | Codex、Claude Desktop、Claude Code 经 MCP 直接领取、推进、交接，不需要人来转述       |
| **压缩后可恢复** | brief / delta / 精确读取 + 长期 records，开工读一份摘要即可续上，不重扫历史          |
| **跨项目知识**   | 独立本地知识库、不可变修订和按需读取，让通用经验复用而不淹没开工 brief               |
| **并发不打架**   | Session 领取、幂等 mutation、乐观并发版本号、租约过期接管、Review 状态全程可追溯     |
| **工程可见**     | 项目时间线、Session 的 Git 上下文、工程统计、在线备份恢复与发布证据同屏呈现          |
| **完全本地**     | 每项目独立 SQLite，仅监听 loopback，令牌每次启动轮换，不需要任何云端账号             |

## 用 ATM 开发 ATM

这个项目自己的规划、任务拆分、跨 Agent 交接与验收，也由 ATM 管理。我们在日常开发中验证的，不只是能不能记下一条任务，而是**换一个 Session 后，能否准确接着做**。

<details>
<summary>展开历史实战快照 · 2026-08-29（不是当前版本统计）</summary>

ATM 自己就是用 ATM 管的。下面是本机 SQLite 里的真实计数，截至 2026-08-29：

| 指标          | ATM 自身开发                | 本机全部 11 个受管项目 |
| ------------- | --------------------------- | ---------------------- |
| 工作项        | 300（282 完成 / 18 取消）   | 1,129（871 完成）      |
| Agent Session | 273，来自 117 个 Agent 身份 | 819                    |
| 进度更新      | 399                         | 1,304                  |
| 长期记录      | 130                         | 1,019                  |
| 事件          | 3,038                       | 11,659                 |
| 时间跨度      | 22 天（8/7 – 8/29）         | —                      |

值得看的不是总量，是**平均每个 Session 只推进约 1.1 个工作项**——273 次开工分布在 117 个不同的 Agent 身份上：Codex 系 144 次、CLI 71 次、Claude Code 30 次，其余为子 Agent 与本地工具。这正是 Agent 开发的常态：单次会话很短，换手极其频繁。同一段时间里，这些 Session 产出了 47,184 行生产代码与 45,314 行测试代码，分布在 648 个文件中。

支撑这个节奏的不是更长的上下文，是每次开工都能拿到一份可信的 brief。

</details>

## 性能与交付证据

事实源必须足够轻，才能成为每次开工的习惯。[性能基准](./scripts/benchmark.ts) 使用真实 SQLite，以下是验收上限，不是当前设备上的实测承诺：

| 场景                        | 门禁上限   |
| --------------------------- | ---------- |
| 应用服务打开数据库          | 3,000 ms   |
| 100 个项目的总览            | p95 200 ms |
| 10,000 条任务的筛选列表     | p95 200 ms |
| 50,000 篇项目文档的中文检索 | p95 300 ms |
| 单次写入并落事件            | p95 100 ms |
| 增量拉取 100 条事件         | p95 100 ms |
| 隔离服务探针的空闲 RSS      | 150 MB     |

服务启动时间不等于桌面首屏时间，服务 RSS 也不是整个 Electron 应用的内存总量。知识库检索与这里的项目文档检索是不同入口；每个版本的实际结果请看对应发行报告。

每个版本还带一份可核对的证据包：候选先算指纹（gitHead、工作区脏状态哈希、源码哈希、lockfile 哈希、各阶段哈希），再逐层验证，每层记录产物的 SHA-256——

**SOURCE_DONE → CI_VERIFIED → PACKAGED_VERIFIED → INSTALLED_VERIFIED**

任一层哈希对不上，流水线就停在那一层。源码测试、打包运行、安装／升级／卸载和本机部署是不同证据，不能互相代替。测试数量与实测值由当轮报告生成，不把旧版本的绿灯贴到新候选上。完整规则见[发布检查表](./docs/release-checklist.md)。

## 产品结构

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/architecture-dark.svg" />
    <img src="./docs/assets/architecture-light.svg" alt="AI Agents 经 MCP 连接本地动态 bridge，与 Electron 桌面 UI、CLI 共用同一套应用服务，写入全局 registry 与每项目 SQLite" width="100%" />
  </picture>
</div>

正式桌面 daemon 每次启动都会轮换本地鉴权令牌。Agent 配置连接的是动态 bridge，而不是把 endpoint 或 token 固定写进长期配置；完整边界见[本地安全模型](./docs/security-model.md)。

## 安装

当前稳定版支持 Windows 10/11 x64。

1. 打开 [Latest Release](https://github.com/ayanamislover/AyanamiTaskManager/releases/latest)。
2. 日常使用选择 `AyanamiTaskManager-Setup-*-win-x64.exe`；需要免安装时选择 portable ZIP。
3. 启动 ATM，在“设置 → Agent 接入”中安装 Codex、Claude Desktop 或 Claude Code 配置。
4. 开启“登录启动”后，ATM 会在 Windows 登录后随机延迟后台启动；关闭窗口只会收进托盘。

应用数据默认位于 `%LOCALAPPDATA%\AyanamiTaskManager`。安装版会把精简 Agent Guide 与完整文档同步到该目录，换设备后仍能从同一路径发现使用说明。

下载后可用 Release 附带的 `SHA256SUMS.txt` 核对文件。Setup 与 portable 是两种分发方式，使用差异见[便携版说明](./docs/portable-usage.md)；`NUPKG` 和 `RELEASES` 是安装版更新文件，不是另一个需要手动安装的应用。

> [!IMPORTANT]
> 不要把 `%LOCALAPPDATA%\AyanamiTaskManager\runtime\daemon.json`、Bearer token、项目数据库或备份提交到仓库。ATM 的运行时发现文件只服务当前 Windows 用户和当前 daemon 实例。

## Agent 接入

ATM 会最小合并现有配置，并在写入前创建备份：

| 客户端         | MCP 配置                                      | 规则与技能                                |
| -------------- | --------------------------------------------- | ----------------------------------------- |
| Codex          | `~/.codex/config.toml`                        | `~/.codex/AGENTS.md`、`~/.codex/skills`   |
| Claude Desktop | `%APPDATA%/Claude/claude_desktop_config.json` | `~/.claude/CLAUDE.md`、`~/.claude/skills` |
| Claude Code    | 由官方 `claude` CLI 注册                      | 与 Claude Desktop 共用                    |

最短工作流：

1. `atm_begin` 开工，并直接使用返回的 brief。
2. 按需读取 READY 叶子 WorkItem，使用 `atm_task_patch` 领取并开始。
3. 只在状态真正变化时写 progress；长期事实、决策、风险和证据写 record。
4. 验证后完成 WorkItem，Session 结束调用 `atm_end`。

只有上下文压缩、长时间离开或明确恢复 working set 时才调用 `atm_brief`。任务过大时，应先按“可交付结果 + 可验证验收”拆成独立叶子 WorkItem。

安装后让 Agent 从这里开始，无需记住源码仓库在哪：

> 执行项目前先访问 ATM 工具，并阅读 `%LOCALAPPDATA%\AyanamiTaskManager\ATM_AGENT_GUIDE.md`；受管开发任务的计划、进度、证据和交接均通过 ATM 管理。

完整规则和字段约定见 [Agent 接入指南](./docs/agent-integration.md) 与 [Agent Guide 在线版](./ATM_AGENT_GUIDE.md)。受管项目未注册时自动创建；只有无法可靠确定项目名称、代码或目录时才请求确认。

| Profile   | 做什么                             | 主要入口                                                                                |
| --------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| `core`    | 开工、找任务、拆任务、恢复与交接   | `atm_begin`、`atm_task_list`、`atm_task_get`、`atm_task_create`、`atm_brief`、`atm_end` |
| `actions` | 领取、开始、检查项、验证与完成     | `atm_task_patch`                                                                        |
| `memory`  | 阶段进度、长期记录、反馈与按需检索 | `atm_progress_add`、`atm_record`、`atm_feedback`、`atm_search`、`atm_delta`             |
| `memory`  | 跨项目知识，只读且按需             | `atm_knowledge_search` → `atm_knowledge_get`                                            |
| `memory`  | 直接发布、更新共享知识             | `atm_knowledge_save`（先查重，更新带旧修订 ID）                                         |

需要参考通用经验时，先搜索知识摘要，再按适用范围读取正文；重要结论保留 `id@revisionId` 引用。有可复用结论时由 Agent 直接发布，不要求用户逐篇导入。更新前用 `atm_knowledge_get(for_edit=true)` 读取完整正文和编辑元数据。项目 Record 只存项目事实，不复制整篇知识。若升级后看不到新工具，请重载客户端 MCP。

工具表拆成 `core` / `memory` / `actions` 三个 profile。工具数量、每个 profile 的 descriptor 字节数、预算与余量由 registry 和预算常量生成，避免文档数字漂移。

<!-- MCP_TOOL_STATS:BEGIN -->

### MCP 工具面统计（生成）

> 以下数字由 `ToolDefinitionRegistry` 的已发布工具和 `schema-budget.ts` 生成；运行 `pnpm generate:mcp-contracts` 更新。

<!-- prettier-ignore -->
| 指标 | 当前值 |
| --- | ---: |
| MCP surface | v5 |
| 正式 Profile 数 | 3 |
| 正式工具总数 | 15 |
| 每个 Profile schema 上限 | 10,240 bytes |
| 每个 Profile 预留 | 512 bytes |
| 每个 Profile 可用预算 | 9,728 bytes |

<!-- prettier-ignore -->
| Profile | 工具数 | Descriptor bytes | 可用预算 | 余量 |
| --- | ---: | ---: | ---: | ---: |
| core | 6 | 8,016 bytes | 9,728 bytes | 1,712 bytes |
| memory | 8 | 9,180 bytes | 9,728 bytes | 548 bytes |
| actions | 1 | 8,164 bytes | 9,728 bytes | 1,564 bytes |

<!-- MCP_TOOL_STATS:END -->

## 日常使用

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/screenshot-overview-dark.png" />
    <img src="./docs/assets/screenshot-overview-light.png" alt="ATM 总览页：跨项目 KPI、需要处理清单、各项目健康度与最近变化时间线" width="100%" />
  </picture>
  <p><sub>总览把所有受管项目的进行中、受阻、等待和在线 Agent 汇到一屏。</sub></p>
</div>

桌面端提供：

- 总览、项目、任务列表/看板/时间线/层级和长期记录；
- Agent 按项目聚合、Session Git 上下文、claim 与交接；
- 临时任务晋升、保存视图、中文搜索和实时事件；
- 在线备份恢复、导入导出、工程统计与托盘通知；
- 本地共享知识库、修订历史、归档与 Markdown 导入／导出；
- 开机随机延迟后台启动，以及关闭到托盘的常驻模式。

更完整的操作说明见[用户指南](./docs/user-guide.md)，故障定位见[排障指南](./docs/troubleshooting.md)，便携版差异见[便携版说明](./docs/portable-usage.md)。

## 本地开发

需要 Node.js `>=22.13.0` 与 pnpm `11.16.0`：

```powershell
git clone https://github.com/ayanamislover/AyanamiTaskManager.git
Set-Location AyanamiTaskManager
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

开发态 Web 界面固定监听 `http://127.0.0.1:9999`；daemon API 使用运行时发现文件声明的独立 loopback 端口。开发和测试可通过 `ATM_DATA_DIR` 指向隔离数据目录。

六道质量门禁，缺一道都不算过：

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

发布流水线在这之上继续：生成并验证 Squirrel 安装版与 portable ZIP，跑 packaged / distribution smoke、性能 benchmark 和安装态验收，最后把上面那份四层证据包落盘。维护者流程见[发布检查表](./docs/release-checklist.md)。

README 里的图和截图都由脚本生成，不手工维护：

```powershell
pnpm exec tsx scripts/render-architecture-diagram.ts
pnpm exec tsx scripts/render-readme-screenshot.ts
```

## 参与贡献

欢迎提交问题、文档改进和经过验证的修复。开始前请阅读[贡献指南](./CONTRIBUTING.md)与[行为准则](./CODE_OF_CONDUCT.md)。安全问题不要公开提交 Issue，请按[安全策略](./SECURITY.md)私下报告。

## 开源许可

AyanamiTaskManager 以 [GNU Affero General Public License v3.0 only](./LICENSE) 发布。项目 logo 与视觉资产的来源说明见[视觉资产来源](./docs/asset-provenance.md)；第三方依赖继续遵循各自许可证。

<div align="center">
  <sub>Local-first · Agent-native · Built with care by Ayanami, Codex and Claude.</sub>
</div>
