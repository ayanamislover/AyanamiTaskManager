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
- **报告**：每条规则在每个受影响的族上一条记录 `{rule:"N-xx@v", family, count, keys_digest}`。计数为 0 的也写，用来证明规则执行过。报告不含正文与密钥（05 §3.4）。
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

## N-02@1 删除的遗留结构（01 C-16、C-25；04 C-L15）

3.0 的 schema 不建这些列、表和关系类型。2.0 没有写入方，只在读路径和完成门里过滤，或者只有迁移回填。有限清单如下，清单外的列一律逐值转换。

| 子项  | 族                                    | 非默认值谓词（附件收录的行）                | 附件行                                | 依据                                                     |
| ----- | ------------------------------------- | ------------------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| N-02a | `<pid>/work_items.archived_at`        | `archived_at IS NOT NULL`                   | `{id, value}`                         | C-16、C-L15；2.0 无写入方                                |
| N-02b | `<pid>/work_items.phase_inferred`     | `phase_inferred <> 0`                       | `{id, value}`                         | C-16、C-25；只有 2.x M0008 回填会写 1                    |
| N-02c | `<pid>/work_items.planned_start_date` | `planned_start_date IS NOT NULL`            | `{id, value}`                         | C-16；`milestones.planned_start_date` 有写入方，不在本条 |
| N-02d | `<pid>/labels`                        | 全部行                                      | 整行（`id, name, color, created_at`） | C-16；2.0 无读写代码                                     |
| N-02e | `<pid>/work_item_labels`              | 全部行                                      | 整行（`work_item_id, label_id`）      | 同上                                                     |
| N-02f | `<pid>/work_item_relations`           | `relation_type IN ('RELATES','DUPLICATES')` | 整行                                  | C-16；2.0 无写入方。`BLOCKS`、`DISCOVERED_FROM` 逐行转换 |

- 主键：N-02a～c 为 `id`；N-02d 为 `id`；N-02e 为 `work_item_id, label_id`；N-02f 为 `source_id, target_id, relation_type`。
- VERIFY：
  - `work_items` 的族比对去掉 a～c 三列（与 N-01 一起按期望值比对）；
  - `work_item_relations` 的族比对只取 `BLOCKS`、`DISCOVERED_FROM` 两类；
  - 附件按同一谓词从源重算，比对计数与摘要；
  - 目标 schema 里不能出现这三列和这两张表（schema 测试）。

## N-03 版本号：恒等不变量，不是豁免

所有表的 `version`（以及 `meta_version`）逐值保留，不重排、不补齐。它没有允许变化的列，由各族的逐列比对直接证明。规则不进报告，也不能被引用来解释任何差异。

## N-04@1 通知设置合并（`notification.enabled` → `notification.mode`）

族 `r/settings`。2.x 的读法（`apps/desktop/src/notification-policy.ts:14–20`）：`mode` 是 `"ALL"`、`"CRITICAL"`、`"OFF"` 之一就用它；否则 `enabled` 恰好是 JSON `false` 时为 `"OFF"`，其余一律 `"ALL"`。3.0 只认 `notification.mode`。

记 `E` 为键 `notification.enabled` 的行，`M` 为键 `notification.mode` 的行。`M` 合法，指 `value_json` 是合法 JSON 且值为上述三个字符串之一（区分大小写，与 2.x 的 `includes` 相同）。

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
- 目标值写成紧凑 JSON 字符串（`"ALL"` / `"OFF"`）。推导出的值总是与 2.x 运行时读到的有效值相同，所以用户看到的通知行为不变。
- 本条取代 05 §6 第 10 条「原样转换，由 W5 决定」（10 R9 优先于 05）。

## N-05@1 lineage 无效边（10 R2、R3）

族 `<pid>/agent_sessions`。**不改目标数据**：`predecessor_session_id` 原值保留。3.0 的 lineage（`service/src/lineage.rs`）在运行时只沿有效边连通，所以无效边天然不构成 lineage 关系。本条只登记判定和计数，供报告与 VERIFY 使用。

- 一条边是 `s.predecessor_session_id = p.id`（同项目）。它无效，当且仅当下列任一成立，按顺序取第一个原因：
  - `CROSS_AGENT`：`s.agent_id <> p.agent_id`；
  - `CROSS_ROLE`：`s.role <> p.role`；
  - `TIME_REVERSED`：`s.started_at < p.started_at`。比较 ISO-8601 UTC 字符串；2.x 一律写 `toISOString()`，字符串序与时间序一致。
- 有效边的时间不减，所以由有效边构成的环只可能出现在同一时刻（所有 `started_at` 相等）。lineage 按 visited 集合求连通分量，环不影响结果，也不需要断边，结果是确定的。报告单独计数 `SAME_INSTANT`：两端 `started_at` 相等的有效边。
- **无法确定时显式失败**：`predecessor_session_id` 指向不存在的 session 时，转换在提交时的外键检查处失败，并报告位置；不猜测、不删边。
- 报告：每个原因一条 `{rule:"N-05@1", family, reason, count, keys_digest}`，主键为 `s.id`。

## 只报告、不改动的遗留值（C-16 的其余部分）

下列值 3.0 保留在 schema 里，作为「仅转换数据」。服务不会写出它们，转换逐值转换，报告里计数，不进附件：

| 编号 | 族                      | 谓词                                                               |
| ---- | ----------------------- | ------------------------------------------------------------------ |
| O-01 | `<pid>/checklist_items` | `kind <> 'ACCEPTANCE'`（`REQUIRED` / `OPTIONAL` / `VERIFICATION`） |
| O-02 | `<pid>/blockers`        | `status = 'CANCELLED'`                                             |
| O-03 | `<pid>/work_items`      | `progress_source = 'STATUS'`（3.0 下次重算时按当前来源覆盖，C-16） |

OPS 效果名 `SET_BLOCKER` 不落库，无需处理。

## 不在本表、由别处保证的

- 项目级 `settings` 非空：VERIFY 失败（R9，不规范化）。
- `projects.archived_at`：原值进 `projects.legacy_json.archivedAt`，由 VERIFY 反投影（C-L15，W1）。
- 进行中的文件事务落定（05 §4.1）：属于 W3d 的状态机，不是数据规范化。
