# 转换规范化规则表（10 R9 / R9′，W3a）

2.x → 3.0 转换时，目标库只允许按本表登记的规则偏离源数据。每条规则带版本号；规则的任何改动（谓词、列、目标值、摘要算法）都要升版本，并在报告里以 `编号@版本` 出现。实现：`store/src/legacy.rs`（转换写入）与同文件的 VERIFY（独立重算）。

本表是 W3 的进入门槛（R9′）：评审通过之前，不宣称转换验收完成。

## 共同约定

- **规范化只作用于目标库。** `business_digest`（05 §5）按源的原始内容计算，不受本表影响。
- **VERIFY 独立证明只发生了登记的变化。** 对每个受规则影响的族，VERIFY 用与转换写入不同的 SQL 从源重算「期望目标」，与目标逐行逐列比对（05 §5.1 的规范化摘要）；另外对每条规则单独核对受影响主键集合：
  - 规则谓词在源上选出的主键集合（期望）；
  - 源与目标实际不同的主键集合（实际），或被舍弃 / 写入附件的主键集合。

  两者的计数与摘要都必须相等。同一类里多改一个未授权的列，族比对失败；计数相同但改错了主键，主键集合比对失败。

- **主键集合摘要**：`sha256("ATM-NORM-1" ‖ 规则编号 ‖ 0x00 ‖ 族名 ‖ 0x00 ‖ 每个主键)`。主键先按字节序排序；单列主键直接取原文，多列主键用 0x1F 连接；每个主键后跟 0x00。空集合也照此计算。
- **族名**：项目表写 `<project_id>/<表>`，registry 表写 `r/<表>`，与 05 §5.1 的 VERIFY 族名一致。
- **报告**：每条规则在每个受影响的族上**恰好**一条记录 `{rule:"N-xx@v", family, count, keys_digest}`；`keys_digest` 是 64 位小写十六进制。计数为 0 的也写，用来证明规则执行过。重复的（规则，族）或格式不对的摘要，VERIFY 报可定位的失败（不 panic）。报告不含正文与密钥（05 §3.4）。
- **报告附件**：被舍弃结构的非默认值写入附件，不进报告正文。附件每个族一组，内容是一组 JSON 行，按主键排序；W3d 把它和 `report.json` 一起写到 `staging\<g>\`。附件可能含用户正文（例如标签名），所以与报告分开存放。

## N-01@1 终态任务上的残留领取（00 C-03、Q-06）

| 项           | 内容                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| 族           | `<pid>/work_items`                                                                                        |
| 输入谓词     | `status IN ('DONE','CANCELLED') AND (claimed_by_session_id IS NOT NULL OR claim_lease_until IS NOT NULL)` |
| 允许变化的列 | `claimed_by_session_id`、`claim_lease_until`                                                              |
| 目标值       | 两列都置 NULL。`assignee_agent_id` 保留作历史；`version`、`updated_at` 不变（转换不是业务写入，N-03）     |
| 主键         | `id`                                                                                                      |
| 依据         | 3.0 进入 DONE / CANCELLED 时清领取（C-03），存量按同一不变量规范化（Q-06）                                |

## N-02@1 删除的遗留结构与取值（00 C-16；01 C-16、C-25；04 C-L15）

00 C-16 采纳：2.0 没有写入方的结构与取值一律删除，转换器遇到非默认值按类计数，内容进报告附件、**不入新库**（00 优先于 01 的「删除或保留为仅转换数据」）。有限清单如下，清单外的列一律逐值转换。a～f 是 3.0 不建的列、表和关系类型；g～i 是列还在、但遗留取值不再合法的三处（schema 的 CHECK 只收 3.0 的取值），改写成 3.0 的取值，改写的选择使 3.0 完成门对该行的结论与 2.0 相同。

| 子项  | 族                                    | 非默认值谓词（附件收录的行）                | 附件行                                | 依据                                                     |
| ----- | ------------------------------------- | ------------------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| N-02a | `<pid>/work_items.archived_at`        | `archived_at IS NOT NULL`                   | `{id, value}`                         | C-16、C-L15；2.0 无写入方                                |
| N-02b | `<pid>/work_items.phase_inferred`     | `phase_inferred <> 0`                       | `{id, value}`                         | C-16、C-25；只有 2.x M0008 回填会写 1                    |
| N-02c | `<pid>/work_items.planned_start_date` | `planned_start_date IS NOT NULL`            | `{id, value}`                         | C-16；`milestones.planned_start_date` 有写入方，不在本条 |
| N-02d | `<pid>/labels`                        | 全部行                                      | 整行（`id, name, color, created_at`） | C-16；2.0 无读写代码                                     |
| N-02e | `<pid>/work_item_labels`              | 全部行                                      | 整行（`work_item_id, label_id`）      | 同上                                                     |
| N-02f | `<pid>/work_item_relations`           | `relation_type IN ('RELATES','DUPLICATES')` | 整行                                  | C-16；2.0 无写入方。`BLOCKS`、`DISCOVERED_FROM` 逐行转换 |
| N-02g | `<pid>/checklist_items.kind`          | `kind <> 'ACCEPTANCE'`                      | `{id, value, status}`（原值）         | C-16；2.0 只写 ACCEPTANCE                                |
| N-02h | `<pid>/blockers.status`               | `status = 'CANCELLED'`                      | `{id, value}`                         | C-16；CANCELLED 无写入方                                 |
| N-02i | `<pid>/work_items.progress_source`    | `progress_source = 'STATUS'`                | `{id, value}`                         | C-16；ProgressSource STATUS 无写入方                     |

g～i 的目标值：

| 子项  | 改写                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N-02g | `kind` 一律改为 `ACCEPTANCE`。另外，`kind = 'OPTIONAL' AND evidence_required = 0 AND status IN ('TODO','DOING')` 的行 `status` 改为 `SKIPPED`。依据：2.0 完成门的检查项谓词排除 OPTIONAL、证据谓词不看 kind（01 §4）；3.0 两条谓词都不看 kind。按此改写，REQUIRED / VERIFICATION、必证或已完成的 OPTIONAL 在两边都照旧生效，不必证且未完成的 OPTIONAL 在两边都不阻塞 |
| N-02h | `status` 改为 `RESOLVED`（完成门只看 ACTIVE，两者在 2.0 与 3.0 都不阻塞）；`resolved_at` 等其余列不变                                                                                                                                                                                                                                                                |
| N-02i | `progress_source` 改为 `NONE`；`computed_progress` 原值保留，3.0 下次重算时按当前来源覆盖（00 C-24 的 complete 也写 NONE）                                                                                                                                                                                                                                           |

`version`、`updated_at` 都不变（N-03）。g～i 的改写不另开规则编号，与 a～f 同属 N-02@1。

- 主键：N-02a～c、g～i 为 `id`；N-02d 为 `id`；N-02e 为 `work_item_id, label_id`；N-02f 为 `source_id, target_id, relation_type`。
- VERIFY：
  - `work_items` 的族比对去掉 a～c 三列，N-01 与 N-02i 的列按期望值比对；
  - `checklist_items`、`blockers` 的族比对按 g、h 的期望值；
  - `work_item_relations` 的族比对只取 `BLOCKS`、`DISCOVERED_FROM` 两类；
  - 附件按另写的谓词从源重算，逐行比对全文；
  - 目标 schema 里不能出现这三列和这两张表，遗留取值写入时撞 CHECK（schema 测试）。

## N-03 版本号：恒等不变量，不是豁免

所有表的 `version`（以及 `meta_version`）逐值保留，不重排、不补齐。它没有允许变化的列，由各族的逐列比对直接证明。规则不进报告，也不能被引用来解释任何差异。

## N-04@1 通知设置合并（`notification.enabled` → `notification.mode`）

族 `r/settings`。2.x 的通知策略（`apps/desktop/src/notification-policy.ts:14–20`）：`mode` 是 `"ALL"`、`"CRITICAL"`、`"OFF"` 之一就用它；否则 `enabled` 恰好是 `false` 时为 `"OFF"`，其余一律 `"ALL"`。3.0 只认 `notification.mode`。

记 `E` 为键 `notification.enabled` 的行，`M` 为键 `notification.mode` 的行。

- **判定按整段文本做 `JSON.parse`**：`M` 合法，指 `value_json` 整段按 `JSON.parse` 解析成字符串，且值为上述三者之一（区分大小写，与 2.x 的 `includes` 相同）；`E` 为 false，指整段解析结果恰好是布尔 `false`。允许首尾空白和字符串里的转义（`"OF\u0046"` 合法且等于 `"OFF"`）；任何位置的原始 NUL（JSON 不允许未转义的控制字符）、尾随垃圾、非字符串值都不合法。SQLite 的 JSON 函数在原始 NUL 处截断，不能单独用作判定（转换侧用 `store/src/jsjson.rs` 的 JS 语义解析器；VERIFY 侧用 SQLite JSON 函数并先排除含原始 NUL 的文本）。
- **与 2.x 运行时的关系**：合法输入上，推导值与 2.x 通知策略读到的有效值相同。2.x 的 `getSetting`（`packages/storage-sqlite/src/registry-workspace.ts:272`）直接 `JSON.parse`，坏 JSON 会抛错；本规则对坏 JSON 取 `"ALL"` 是登记的修复，不是 2.x 的原有行为。

| 情况                       | 输入谓词                     | 目标                                                                                                                                                           |
| -------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两者都没有                 | —                            | 不适用，不建行（3.0 缺省即 `ALL`，与 2.x 相同）                                                                                                                |
| 只有 `M`，合法             | —                            | 不适用，原样转换                                                                                                                                               |
| 只有 `M`，不合法（异常值） | `M` 存在且不合法、`E` 不存在 | `M.value_json` 改为 `"ALL"`；`version`、`updated_at` 不变                                                                                                      |
| 只有 `E`                   | `E` 存在、`M` 不存在         | 删 `E`；新建 `M`：`value_json` = `"OFF"`（`E` 为 JSON `false`）或 `"ALL"`（其余，含非 JSON、字符串 `"false"`、`0`、`null`）；`version`、`updated_at` 取 `E` 的 |
| 两者都有，`M` 合法         | `E` 存在                     | 删 `E`；`M` 原样                                                                                                                                               |
| 两者都有，`M` 不合法       | `E` 存在                     | 删 `E`；`M.value_json` 按 `E` 推导（同「只有 `E`」）；`M` 的 `version`、`updated_at` 不变                                                                      |

- 允许变化的列：`settings` 行的增删（只限这两个键）与 `notification.mode` 的 `value_json`。
- 主键：`key`。受影响集合 = 被删除、被新建或 `value_json` 被改写的行的键：`E` 存在时含 `notification.enabled`；`M` 被新建或改写时含 `notification.mode`。「两者都有、`M` 合法」只含 `notification.enabled`。
- 目标值写成紧凑 JSON 字符串（`"ALL"` / `"OFF"`）。合法的 `M` 原样保留，不重写成紧凑形式。
- 本条取代 05 §6 第 10 条「原样转换，由 W5 决定」（10 R9 优先于 05）。

## N-05@1 lineage 无效边（10 R2、R3）

族 `<pid>/agent_sessions`。**不改目标数据**：`predecessor_session_id` 原值保留。3.0 的 lineage（`service/src/lineage.rs`）在运行时只沿有效边连通，所以无效边天然不构成 lineage 关系。本条只登记判定和计数，供报告与 VERIFY 使用。

- 一条边是 `s.predecessor_session_id = p.id`（同项目）。它无效，当且仅当下列任一成立，按顺序取第一个原因：
  - `CROSS_AGENT`：`s.agent_id <> p.agent_id`；
  - `CROSS_ROLE`：`s.role <> p.role`；
  - `TIME_REVERSED`：`s.started_at < p.started_at`。
- 有效边的时间不减，所以由有效边构成的环只可能出现在同一时刻（所有 `started_at` 相等）。lineage 按 visited 集合求连通分量，环不影响结果，也不需要断边，结果是确定的。报告单独计数 `SAME_INSTANT`：两端 `started_at` 相等的有效边。
- **时间接受域**：参与 predecessor 边的 session（有 predecessor，或是别人的 predecessor），`started_at` 必须是 `toISOString()` 的形状 `YYYY-MM-DDTHH:MM:SS.sssZ`，且是真实存在的日期时间（不接受 2 月 30 日、小写 z、省略毫秒等）。在这个域里字符串序就是时间序，与 3.0 运行时 lineage 的比较一致；同一时刻只有一种写法。2.x 一律写 `toISOString()`。不参与边的 session 不受约束。
- **无法确定时显式失败**：
  - 时间不在接受域里：转换失败，错误点名项目、session 与字段（`agent_sessions <id>.started_at`），不按字典序猜先后，也不改原值；
  - `predecessor_session_id` 指向不存在的 session：转换在提交时的外键检查处失败，并报告位置；
  - 两种情况都不删边。VERIFY 另用 SQLite 日期函数核对接受域（重新格式化后不变）。
- 报告：每个原因一条 `{rule:"N-05@1", family, reason, count, keys_digest}`，主键为 `s.id`。

OPS 效果名 `SET_BLOCKER`（C-16 的最后一项）不落库，无需处理。

## 不在本表、由别处保证的

- 项目级 `settings` 非空：VERIFY 失败（R9，不规范化）。
- `projects.archived_at`：原值进 `projects.legacy_json.archivedAt`，由 VERIFY 反投影（C-L15，W1）。
- 进行中的文件事务落定（05 §4.1）：在副本上按 2.0 的启动恢复规则落定，属于 W3b（ATM-T-0621），不是数据规范化。
