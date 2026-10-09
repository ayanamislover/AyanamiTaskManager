# atm-http 报告：W4j 易用性门

本文是 W4j（11 §5 的易用性门 U-1～U-7 与 surface v6 文档）的交付说明与评审记录，只写 W4j 新增的内容。W4b～W4h 的实现（传输、工具表与 schema、写入映射、错误信封、resolve、桥、REST）在各自阶段只做了变异验红，没有单独的 peer 评审，由 W4 整体评审一并审（本文早先写成「各有评审」，不属实，已改正）。

## 1. 易用性门的状态

| 门                 | 用例 / 证据                                                                                                                                                         | 状态                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| U-1 冷启动 Agent   | 真实 Claude Code 与 Codex 经真实 `atm-mcp.exe` 跑 W1–W9；执行器 `output/u1/u1.py`，被测服务 `http/examples/u1-server.rs`。用户 2026-10-09 定的规模：先每个流程 3 次 | 通过（第三轮两边各 27/27，§4） |
| U-2 金标脚本       | `tests/bridge.rs` `u2_golden_scripts_take_the_proposed_number_of_calls`：经真实桥，W1–W9 每个流程的调用数等于 11 §1「提案后」列                                     | 通过                           |
| U-3 猜错语料       | `tests/fix.rs` `u3_guesses_succeed_directly_or_after_one_fix`（W4e）                                                                                                | 通过                           |
| U-4 错误必有下一步 | `tests/fix.rs` 静态、全码扫与动态检查；`support::call_as` 对每次出错都核对信封（W4e）                                                                               | 通过                           |
| U-5 剥离 schema    | `tests/tools.rs` `descriptions_survive_a_stripped_schema`、`tests/schema.rs`（W4c）                                                                                 | 通过                           |
| U-6 安全规则零摩擦 | `tests/bridge.rs` 的七个 `u6_` 场景：单 Agent、压缩、崩溃重启、丢响应、子代理、静默 30 分钟、反例                                                                   | 通过                           |
| U-7 体积           | `tests/tools.rs` `every_profile_fits_its_byte_budget`；数字见 `docs/generated/mcp-tool-contracts.md`（core 16,018 / 16,180）                                        | 通过                           |

## 2. 金标脚本与零摩擦场景查出并修掉的缺陷

都在正常路径上，Agent 照工具说明做就会撞上：

1. **无参 `atm_brief()` 没有会话**（W7，`SESSION_REQUIRED`）。上下文压缩后 Agent 照 instructions 调无参 brief。修订：`atm_brief` / `atm_task_list` 既没带 session 也没带 project 时，白名单客户端取本连接组的默认会话（`agent.rs` `connection_session`，`resolve.rs` `Service::connection_session`）。
2. **崩溃重启后写不了自己的任务**（W8，`CLAIM_NOT_OWNED`）。旧会话要等扫描（每分钟）才关闭，新进程 begin 时还在线，`resume:auto` 接不上。修订：begin 在规范化之后先关闭同 agent、role、cwd、不同连接组、客户端进程已退出的在线会话（`session.rs` `close_exited_clients`，R11 P1-3 第 2 条）。
3. **子代理顶替主会话**（U-6 子代理场景）。同一连接组里开 SUBAGENT 会话后，默认会话变成了它。修订：默认会话只取 PRIMARY（`resolve.rs` `default_session`，R11 A1 的独立不变量）。
4. **写入之后不刷新 Git 上下文**（写 GUIDE v6 时对照 2.x 查出）。2.x 在进度、verify、complete、end 之后按 cwd 重新观察 Git（02 S-022、X-05），Rust 只在 begin 时采集。修订：`Service::refresh_git_after_write` 在事务外跑 git、按 S-022 写入；http 层在这几种写入成功且不是重放时调用（00 C-03），`start` 不刷新。用例 `tests/write.rs` `writes_refresh_the_git_context_but_replays_do_not`。

U-1 第一轮（Codex，27 次）又查出两处：

5. **brief 只给 next 的 key，没有标题和计数**（第一轮 Codex 的 W1、W4、W5、W6、W7 每次都多出一次 `atm_task_list`）。Agent 拿到 `next: ["ATM-T-0001", …]` 不知道哪个是要做的那件，只好再列一次。修订：brief 增加 `nextTitles`（key→标题）、`counts.ready`、`counts.open`（`read/brief.rs`）；core instructions 写明 next/nextTitles 可以开工、own 是已领取的任务，直接写、不用再 start（W8 多出的那次 start）。用例 `service/tests/read.rs` s052。
6. **有界数值越界没有 fix.call**（`atm_search limit 50`、`atm_task_get last_progress 99`）。原来只报「参数不合法」，Agent 要自己猜上限。修订：有上限的数值越界时夹到边界，`did_you_mean` 给出夹过的值，fix.call 就是夹过的同一调用；没有上限的（版本号）照旧拒绝、不猜（`schema.rs`）。用例 `tests/schema.rs` `bounded_numbers_are_clamped_and_unbounded_ones_are_not`，U-3 语料加了这两条。

U-1 第二轮（Codex 与 Claude Code 各 27 次）又查出两处：

7. **给没开工的任务记进度，任务停在 READY**（Codex W5 每次先补一次 `start`，第一轮里没补的两次留下了「有进度却没人领」的任务）。11 §1 的 W5 默认任务已经在做，冷启动时不是。修订：任务进度遇到 BACKLOG / READY / CLAIMED 时在同一事务里先 `start`，回执的 `auto_applied` 写明（`StateWrite::Progress`，`service/src/work/patch.rs` `auto_start_for_progress`）。和状态写入不同，这一步尽力而为：前置没完成或领不到时不补、不报错，进度照记。带 blocker 的进度与 `task_patch` 的 `block` 一致，先 `start` 再阻塞；补不上时 READY 上照旧拒绝、零写入。用例 `service/tests/memory.rs` `u1_progress_on_an_unstarted_task_starts_it`、`tests/write.rs` `progress_on_an_unstarted_task_reports_the_auto_start`、`domain/tests/ergonomics.rs`。
8. **只有 brief 和 task_list 用默认会话**（Claude Code W4 三次都先不带 session 调 `atm_task_get` 拿检查项 id，SESSION_REQUIRED 后重试）。修订 1 只覆盖了压缩后的那两个工具。修订：要项目的读（`atm_task_get`、不在 tools/list 里但仍可调用的旧名 `atm_delta`，以及按列表或 op_id 回查的 `atm_search`）同样补默认 session；全文搜索不补（服务只在 op_id 回查时收 session）。列表搜索里的 session 只用来推出项目，推完就去掉。instructions 与 GUIDE 改为「读写都可以省略 session」。用例 `tests/resolve.rs`、`tests/bridge.rs` 的压缩场景。

修订 8 的变异验红又引出一处：

9. **「这个参数不能带」的 fix 方向反了**。`atm_search` 不带 op_id 时带了 session（全文搜索，或已经给了 project 的列表），被拒后 `fix` 是 `add_param session`，照做只会原样再错一次。这类 session 不改变调用的意思，去掉就对。修订：校验函数把它报成 `ProblemKind::Unused`（新问题类型：参数在这里不起作用）；拒绝里只有这类问题时，`fix.call` 就是去掉它们的同一调用。真正的冲突（list 与 query 同时给、别名与规范名的值不同）照旧不猜。U-4 的全码扫描抓到了第二条通道：fix 生成器从上下文补 session / project，生成的列表搜索自己过不了 schema；`fix::call` 现在去掉被报成 Unused 的参数。用例 `tests/schema.rs` `unused_parameters_are_dropped_by_the_correction`，U-3 语料加了两条。服务层同名的两处拒绝在 MCP 与 REST 都被 schema 先拦住，到不了，没有改。

**测试脚手架的漏洞**（修订 8 时发现）：`support::call_as` 和 `bridge.rs` 的 `Agent::call` 只看 `isError`，协议层的错误（工具不在这个 profile 上）没有 `result`，于是被当成成功。现在两处都断言拿到了工具结果。收紧后原有用例全绿，说明之前没有用例靠这个漏洞通过；修订 7 的 http 用例写错了 profile，正是被它掩盖、又因为断言了回执内容才暴露出来的。阳性对照见下面的 `w4j-reads` 证据（在结果不被检查的调用里打到 profile 之外的工具，两处都变红）。

修订 4～9 的变异验红：`w4j-progress-service-mutation-evidence.json`（4 RED）、`w4j-progress-domain-mutation-evidence.json`（1 RED）、`w4j-reads-mutation-evidence.json`（5 RED，其中两条是脚手架断言的阳性对照）、`w4j-unused-mutation-evidence.json`（4 RED），以及`output/w4-evidence/w4j-brief-mutation-evidence.json`（3 RED，68e938b）、`w4j-clamp-mutation-evidence.json`（2 RED，5fb9401）、`w4j-git-mutation-evidence.json`（5 RED，82a16f7）。

## 3. 文档由代码生成（W4j-3）

`tests/docs.rs` 从代码生成：

- `docs/generated/` 下四页：
  - `mcp-tool-contracts.md`：来自 `tools::PROFILES`；
  - `work-item-operations.md`：来自 `atm_domain::work` 的状态机、自动补 start、版本要求，以及 task_patch 的字段映射；
  - `mutation-acknowledgement.md`；
  - `error-codes.md`：来自 `ErrorCode::ALL`；
- `ATM_AGENT_GUIDE.md`、`docs/agent-integration.md`、`README.md` 里成对标记之间的段落。

仓库里的文件与生成结果必须逐字节一致（`ATM_DOCS_BLESS=1` 重写）。写入回执和错误信封的字段表各对照几次真实调用：回执里出现字段表没写的字段，或字段表里的字段一次都没出现，都会红（`merges` 有专门用例，不要求在样本里出现）。表格每行列数一致。

锁定 v5 TS 生成结果的 6 条 TS 断言与两个 TS 生成脚本已退役（ATM-D-386）；TS 的生成函数随 W8 去掉 Node 时一并删除。

## 4. U-1 冷启动 Agent

### 4.1 做法

- **被测服务**：每次运行一个新的合成数据根（`output/u1/runs/<流程>-<客户端>-<n>/`）。`u1-server` 在里面起真实的 atm-http，经 MCP 接口按流程预置数据：
  - 除 W2 外都有一个绑定到仓库目录的项目和两个任务，W4 的任务带两条检查项；
  - W8 另有一个同 agent_id 的前任会话，它领着任务、写过进度，客户端身份指向一个已经退出的进程。

  预置好后发布 daemon.json。CLI 经真实的 `atm-mcp.exe`（`--profile core` / `memory`，`ATM3_DATA_DIR` 指向数据根）连进来。跑完后服务把任务、记录、会话导出，按最终状态判定流程是否完成，不看 Agent 自己的汇报。

- **Claude Code**：`claude -p`，`--strict-mcp-config` 只用本次传入的两个 MCP，`--tools ""` 关掉全部内置工具，`--disable-slash-commands` 关掉 skills。
- **Codex**：`codex exec`，`--ignore-user-config` 不读用户配置里登记的 MCP，`--ignore-rules`，只读沙箱。模型 `gpt-6-astra`，推理强度 medium。
- **提示词**：只描述要做的事和 agent_id，不提工具名以外的任何 ATM 用法。
- **计数**：从 CLI 的 JSON 事件流里数 atm 工具调用和出错的调用。上限的构成见 §4.2 之后的「计数口径」。

### 4.2 已知的偏差

- **Claude Code 仍会注入用户的全局 CLAUDE.md**，里面有 ATM 的通用规则（例如「开工调用一次 atm_begin」）。不注入的唯一开关 `--bare` 不使用 OAuth 登录，所以没有用它。GUIDE 本身读不到：内置工具都关了。
- **Codex 的内置 shell 关不掉**：它能看到只读文件系统。提示词要求只用 ATM 工具；事件流里出现的内置工具调用单独计数并列出。
- **W7（压缩后继续）是模拟的**：冷启动 CLI 没法在一次运行里真的压缩上下文。提示词让 Agent 在同一次运行里「忘掉」之前回执里的 session、项目和任务 key，再记进度。

- **计数口径**：非 W9 的流程最后一次成功的 `atm_end` 不计入（照 instructions 收尾，11 §1 把结束单列为 W9）；出错的调用一律计入。上限由三部分组成，只有「被测动作」一列来自 11 §1「提案后」：

  | 流程 | 准备         | 被测动作（11 §1「提案后」）          | 验证                         | 上限 |
  | ---- | ------------ | ------------------------------------ | ---------------------------- | ---- |
  | W1   | —            | begin（1）                           | —                            | 1    |
  | W2   | —            | begin（1）                           | —                            | 1    |
  | W3   | begin        | create（1）                          | —                            | 2    |
  | W4   | begin        | start、检查项、complete（2–3，取 3） | —                            | 4    |
  | W5   | begin        | progress、record（2）                | —                            | 3    |
  | W6   | begin        | wait_user（1）                       | —                            | 2    |
  | W7   | begin、start | 压缩后找回上下文（0–1，取 1）        | progress（找回的上下文能用） | 4    |
  | W8   | —            | 重启后 begin（1）                    | complete（接上的领取能用）   | 2    |
  | W9   | begin        | end（1）                             | —                            | 2    |

  W7、W8 的「验证」是证明被测动作成功的那一次写入；被测动作本身的预算仍是 11 §1 的 0–1 与 1。

- **判定**：按服务导出的最终状态判定流程是否完成，不看 Agent 自己的汇报。W1 有本 Agent 的会话即完成；W2 还要求建出了项目；W4 要求任务 DONE 且证据里有提示词给的「12 条」（完成闸门要求两条检查项都完成，所以 DONE 就意味着检查项也完成了）；W5 要求进度与决策记录都在；W6 要求 WAITING_USER 且等的是「测试账号」；W8 要求接上前任会话后把任务做完（DONE，证据里有「已修复」）；W9 要求本 Agent 的会话以 EXPLICIT_END 关闭。

### 4.3 结果

门槛按用户定的规模换算（11 §5 原文是每流程 10 次）：每次运行的调用数 ≤ 上限；schema 错误为 0 的运行 3/3；每个流程错误数的中位数为 0。

| 轮次 | 被测服务     | Codex（27 次）                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Claude Code（27 次）                                                       | 据此修掉的   |
| ---- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------ |
| 1    | 5fb9401 之前 | 21/27 判为完成：W1、W5 各 3 次判为未完成。判定器与 u1-server 的导出当时各有问题（W1 的判定条件比现在严；W5 导出记录时 `limit 50` 越界、导不出记录，68e938b 修正），但第一轮没有保留运行状态，无法重算，照原记录列为未完成。0 错误、0 schema 错误。当时的口径把末尾的 `atm_end` 也计入，只有 W2、W9 在上限内；扣掉末尾 end 后仍超上限的有 W1（多 `atm_task_list`）、W5（多 `atm_task_list`，一次另多 `start`）、W6（多 `atm_task_list`）、W7（多 `atm_task_list`）、W8（多一次 `start`） | 未跑（CLI 没读到登录令牌）                                                 | 修订 5、6    |
| 2    | 68e938b      | 26/27 完成（W6 第 3 次 CLI 自己退出，0 次调用）；W5 三次各多一次 `start`                                                                                                                                                                                                                                                                                                                                                                                                                | 27/27 完成；W4 三次各 1 次 SESSION_REQUIRED；W1 一次多一次 `atm_task_list` | 修订 7、8、9 |
| 3    | eff50f9      | **27/27 完成，0 错误，0 schema 错误，每次都在上限内**                                                                                                                                                                                                                                                                                                                                                                                                                                   | **27/27 完成，0 错误，0 schema 错误，每次都在上限内**                      | —            |

第三轮的数据：`output/u1/results/{codex,claude}-round3.jsonl`；每次运行的目录（CLI 事件流 `transcript.jsonl`、服务导出 `state.json`、合成数据库）在 `output/u1/runs/`。第二轮 Claude W1 多出的那次 `atm_task_list` 第三轮没有再出现；当时没保留运行目录，原因无从核对。

各流程第三轮的调用数（两个客户端相同）：W1 1、W2 1、W3 2、W4 3、W5 3、W6 2、W7 4、W8 2、W9 2。W4 比上限少一次：检查项随 complete 一并提交，没有单独的检查项调用。两边走法不同：Claude Code 先 `atm_task_get` 拿检查项 id，再一次带 `checklist` 的 complete；Codex 先显式 `start`，再一次 complete，检查项按标题写在 `checklist` 里。内置工具调用两边都是 0。

## 5. 评审记录

| 轮次 | 报告                                         | 结论                                                      |
| ---- | -------------------------------------------- | --------------------------------------------------------- |
| 1    | `output/peer-atm3-w4j-r1.md`（绑定 f7543ad） | CHANGES_REQUESTED：R1-P1-01，R1-P2-01、R1-P2-02           |
| 2    | `output/peer-atm3-w4j-r2.md`（绑定 db428ad） | **APPROVED**：R1-P1-01、R1-P2-01、R1-P2-02 关闭，无新问题 |

第一轮的修订：

| 编号     | 问题                                                                                                                                                                                                                      | 修订                                                                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-P1-01 | 字段问题可以确定地更正（夹取、别名）时不再跑组合规则：`atm_search {project, session, list, limit:50}` 的 fix.call 夹了 limit 却留着 session，照做还要再改一次；`{list, query, limit:50}` 的 list / query 真冲突也给了更正 | `Tool::validate`：字段问题都能更正时，在更正过的参数上照样跑组合规则；Unused 一并去掉，真冲突就不给更正。对外给出的 `corrected` 再校验一遍，过不了就不给（MCP 与 REST 的参数错误都经这里）。用例 `tests/schema.rs` `field_corrections_still_meet_the_combination_rules`，U-3 语料加上这条组合猜错 |
| R1-P2-01 | `bridge.rs` 的旧 `Bridge::call` / `ok()` 仍把协议层错误（null 结果）当成功                                                                                                                                                | `Bridge::call` 断言拿到了工具结果（工具级错误也有 result，只有协议错误没有）；`ok()` 另断言结果是对象。要测协议错误的用例本来就直接用 `request`                                                                                                                                                   |
| R1-P2-02 | §4.3 把第一轮写成「全部完成」，原始记录是 21/27；上限写成「提案后列加开工一次」，W7、W8 不是这样                                                                                                                          | §4.3 第一轮照原记录列出（21/27，原因无法重算的如实写明），并列出当时口径下的超限；§4.2 列出每个流程上限的准备、被测动作、验证三部分。第 5 条缺陷的出现范围也按原始记录改正                                                                                                                        |

第一轮修订的变异验红：`output/w4-evidence/w4j-r1-mutation-evidence.json`，5 RED。其中：

- 两条是 `Bridge::call` / `ok()` 的阳性对照。
- 单独去掉「真冲突不给更正」那一行是等价变异：外层的再校验会拦下仍有冲突的更正，它在上一版证据里 SURVIVED。所以这一条改为与再校验同时关掉；再校验单独的作用另有一条，由 `a_correction_that_would_not_pass_is_withheld` 验红。

这次修订改了 `schema.rs`、`bridge.rs`，`w4j-clamp`、`w4j-unused`、`w4j-reads` 三份证据随之在新候选上重跑。`w4j-unused` 的第一条变异的锚点因缩进变化改写过。

W4 整体评审准备时的一处更正：befd0ae 以为 `atm_delta` 不在任何 MCP profile 上，把它从默认会话名单里去掉了。实际上它是并入 brief 之后保留的可调用旧名（`tools.rs` 开头的说明），照 2.x 恢复流程不带 session 调它的 Agent 会被 SESSION_REQUIRED 挡住。已加回名单，`tests/resolve.rs` 补了这一条，`mut-w4j-reads.py` 加了对应的变异。
