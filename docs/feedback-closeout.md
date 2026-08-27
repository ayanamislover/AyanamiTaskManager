# ATM Feedback 闭环矩阵

> 基线：`C:\Users\ayanami\Desktop\ATM_Feedback.md`，1,006 行，SHA-256
> `4D04861551FB45911734C7AEDD1726052481481054E4CCAC63324954E97B789B`，最后修改
> `2026-08-26T22:37:47.1673052Z`。本矩阵覆盖 27 个独立编号和 10 个补充标题。

## 判定口径

- `DONE` 表示实现已进入源码并有自动回归；最终安装包、GitHub CI 和异构 Peer 结论仍以当次
  `docs/release-checklist.md` 为准。
- 严格拒绝超过上限的 Record 摘要是有意的数据完整性策略；不会静默截断用户写入。
- 候选只用于诊断，不会在写操作中自动模糊路由；候选不得包含路径、token 或内部数据库 ID。
- Objective、Milestone、EPIC 表达目标与范围；长期执行必须拆成可独立交付和验收的叶子 WorkItem。

## 27 项主矩阵

| 编号 | 状态 | 实现与验收锚点                                                                                                                                                                                        |
| ---- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 | DONE | `atm_begin` 身份字段与原子回执不可截断；提交 `487a6a7`，回归 `packages/mcp/test/mcp.test.ts`、`packages/protocol/test/session-begin.test.ts`。                                                        |
| P1-1 | DONE | 公共 schema 与运行时 Zod 同源、静态 core/memory Profile 严格且有预算守卫；提交 `487a6a7`、`cac460c`，回归 `packages/mcp/test/schema-truth.test.ts`、`profile-surface.test.ts`、`surface-v3.test.ts`。 |
| P1-2 | DONE | Zod issues 全量聚合并保留数组路径；提交 `ef8ccfa`，回归 `apps/daemon/test/error-status-mapping.test.ts` 与 MCP schema 契约测试。                                                                      |
| P2-1 | DONE | delta 按真实返回条目续页，`hasMore`/cursor 不再谎报；提交 `1ccc39a`，回归 `packages/application/test/search-and-delta.test.ts`、`packages/mcp/test/read-plane.test.ts`。                              |
| P2-2 | DONE | `supersedes` 同时接受内部 ID 与公开 Record key，失败事务不落账；提交 `21b990b`，回归 Session/Record continuity 测试。                                                                                 |
| P2-3 | DONE | 300 code-point 上限公开于 schema，错误含 received/maximum；提交 `24cce16`、`efe803d`，回归 protocol/storage/daemon/MCP 的 `record-summary-length` 与 `record-unicode` 测试。                          |
| P2-4 | DONE | `VERSION_CONFLICT` 返回 expected/actual、当前快照和有界 recent changes；提交 `ef8ccfa`，回归 `apps/daemon/test/version-conflict-details.test.ts`。                                                    |
| P2-5 | DONE | list/detail 对 checklist、progress、phase 与 waiting 投影一致；提交 `1ccc39a`、`a1f14d0`、`e7bcc5a`，回归 read-plane 与 phase/waiting 测试。                                                          |
| P2-6 | DONE | MCP `snake_case`、REST `camelCase` 的转换边界已写入 Guide 与集成文档；提交 `7a9b631`、`02426ff`。                                                                                                     |
| P2-7 | DONE | REST Zod 入参错误为 400 `INVALID_ARGUMENT`，真正内部故障仍为 500；提交 `ef8ccfa`、`2f12284`，回归 `apps/daemon/test/error-status-mapping.test.ts`。                                                   |
| A-1  | DONE | project/task/session/milestone 动态标识返回有界安全候选，未授权请求不泄漏且写失败零副作用；ATM-T-0102、ATM-T-0127，回归 daemon NOT_FOUND candidates 与 MCP surface 测试。                             |
| A-2  | DONE | 已提交 op 可在关闭 Session 后回放；仅启动恢复原因可原子创建唯一 successor，显式关闭不复活；提交 `8d2fbbd`、`3c1ba92`、`a809c39`，回归 `session-rotation`、`startup-successor`。                       |
| A-3  | DONE | MCP Surface `v3`、schema hash 与生成日期在 initialize、begin 和 Guide 对齐；提交 `487a6a7`、`cac460c`、`02426ff`，回归 `surface-v3.test.ts`。                                                         |
| A-4  | DONE | 字段级 `expected_fields` 允许无关字段安全合并，同字段竞争仍冲突；提交 `d0521b6`、`84caec1`，回归 application/MCP workflow composites。                                                                |
| A-5  | DONE | brief 直接复用、精确读取、原子组合写、默认双 Profile 和稀疏进度共同降低首调与往返成本；ATM-T-0100/0101/0105/0122/0131。                                                                               |
| C-1  | DONE | Review request/submission、verdict、候选哈希、Record 与父 checklist 原子落账；提交 `a90edd5`、`89a018d`，回归 application/daemon/MCP `review-workflow.test.ts`。                                      |
| C-2  | DONE | 只读 reconcile 区分 ACTIVE、LEASE_EXPIRED_ONLINE、STALLED、POSSIBLY_COMPLETE；提交 `793e918`、`e7bcc5a`，回归 application/daemon/UI reconciliation 测试。                                             |
| C-3  | DONE | `progressBreakdown` 同时公开计算值、报告值、来源、分母和门禁阶段；提交 `a1f14d0`、`babda36`，回归 phase/waiting 与 UI task-progress。                                                                 |
| C-4  | DONE | phase 与 waitingOn 正交持久化，VERIFYING 等待后可恢复原阶段；提交 `a1f14d0`，回归 storage/application phase-waiting。                                                                                 |
| C-5  | DONE | Task/Record/Progress/Session 按公开标识精确读取，长字段 continuation 可无损拼回；提交 `cc90ebf`、`58cbed5`、`60faf54`、`2aaec19`，回归各层 `exact-read.test.ts` 与 MCP brief/read-plane 测试。        |
| C-6  | DONE | 创建即分派、单版本批量 checklist、原子 verify-and-complete、结构化 cancel 与 Review 组合写；提交 `7c0ad69`、`d0521b6`、`84caec1`，回归 workflow composites。                                          |
| S-1  | DONE | 状态错误公开合法操作；completion gate 单次聚合 checklist/evidence/children/blocker/dependency/verification/current-state；提交 `ef8ccfa`，Guide 给出可执行出路。                                      |
| S-2  | DONE | brief 以整 Record/整 section 装载并提供冻结 continuation，不再腰斩摘要；提交 `40a6508`、`5e17051`，回归 storage/application/MCP brief tests。                                                         |
| S-3  | DONE | Session topic/subject key 与相关记录成为公共写入/读取字段；提交 `0c28a23`、`d575b9f`，回归 protocol/daemon Record topic tests。                                                                       |
| G-1  | DONE | structured `completed` 可绑定 WorkItem；未绑定回执给出 unlinked/open_work_items；提交 `a1aa2ae`、`1c87227`、`2b924b9`，回归 progress receipt/summary。                                                |
| G-2  | DONE | evidence 兼容旧字符串并支持类型化引用，ATM 公开 key 解引用失败零写入；提交 `65d9463`，回归 MCP mutation contracts 与 protocol tests。                                                                 |
| G-3  | DONE | 写回执回显 op_id，Record/Progress/Delta 保留来源，search 可按 op_id 精确回查；提交 `21b990b`、`65d9463`，回归 exact-read 与 operation trace tests。                                                   |

## 10 个补充标题

| 补充项                           | 闭环位置                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| 补 P1-1：空 schema 定量          | strict schema 与 7,680-byte Profile 预算由 `schema-truth` / `profile-surface` 自动守卫。 |
| 补 P2-3：summary 上限不在 schema | `maxLength` 已进入 public schema；Unicode code-point 边界有阳性/阴性测试。               |
| 补 P2-4：冲突诊断另一半          | current snapshot、recent changes 与 `changes_complete` 共同避免把近似事件冒充精确 diff。 |
| 补 P1-1：五个字段名与首调失败率  | public required/enum/conditional rules 与 runtime 同源；Guide 列明 Profile 工具面。      |
| 补 A-3：Guide 有、schema 没有    | Surface v3/hash、Guide 契约锚点和 schema 守卫三方绑定。                                  |
| 补 C-6/A-4：batch 单起始版本     | checklist batch 只收任务一个 expectedVersion，一次事务、一次版本推进、失败全回滚。       |
| 补 C-2：廉价对账信号             | `POSSIBLY_COMPLETE` 只解析安全的显式产物路径，仅提示复核、不自动关单。                   |
| 补 A-5：读取侧双会话实例         | begin brief 直用、exact read、cursor 和 delta 避免全历史重扫。                           |
| 补 A-5：只兑现一半实例           | 默认 core+memory 双 Profile；关闭 memory 明示失去的五个工具和需重载客户端。              |
| G 组前置三条对比                 | schema 漂移、related records、brief 截断分别由 P1-1、S-3、S-2 的回归覆盖。               |

## 发布级验证

最终候选必须在干净 HEAD 上依次通过 format、typecheck、test、E2E、benchmark、build、Forge make、
packaged smoke、distribution smoke；随后实装到 `%LOCALAPPDATA%\AyanamiTaskManager`，从实际写入的
Codex、Claude Desktop、Claude Code 双 Profile 配置启动 bridge，验证共享状态、Session 恢复、Review、
reconcile、后台自启和数据连续性。具体版本、提交、制品哈希、安装目录与 GitHub CI 结果记录在
`docs/release-checklist.md`。
