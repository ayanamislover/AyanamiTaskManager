# 转换报告与对象族清单（05 §3.4、§5.2；W3b1）

转换器（`store/src/legacy.rs`）的报告按一张固定的对象族表组织。族表在 `store/src/legacy/families.rs`，用例 `the_family_table_matches_05_and_claims_every_2x_table` 按 05 逐行手抄期望值比对。

## 族表

- **编号**沿用 05 §5.2：R1–R12（registry）、K1–K5（knowledge）、P1–P11（每个项目）、F1–F7（数据根文件）。§5.2「显式排除」表的各行编为 X1–X12，顺序与表格相同。同一编号可以有多个族，例如 P3 是十四张表。
- **每张 2.x 表恰好归一个族**。FTS 的影子表（`_config/_content/_data/_docsize/_idx`）随主表归族。转换入口的登记完整性检查（`prepare_source`，在工作副本上）也用这张表，所以族表里少登记一张表，转换就拒绝这个源（`UnknownTable`）。
- **decision**：`CONVERTED`（逐行或逐文件进新库）、`REBUILT`（派生数据，在新库重建，查询等价）、`DROPPED`（不进新库，`drop_reason` 写理由）、`REFERENCED`（不复制，只登记引用）。
- **business_digest**：是否纳入回滚检测（05 §5.2「纳入」列）。X 类和 F7 不纳入。
- **pending**：还没实现的族及负责的任务：W3b5（sync / dispatch）、W3b6（进行中的文件事务）。不按数据根输入时，数据根下的文件族也都算 pending。`Report::pending()` 列出这些族实例，**W3d 的提交门要求它为空**。

### search_documents 与 knowledge_fts：REBUILT

- **search_documents**：2.0 没有全量重建例程（05 §1.4），文档内容只能从它自己的行里来。3.0 把文档行带进 `search_docs`，`search_fts` 由触发器按这些行重新建索引；2.0 的 `search_documents_fts` 不搬。校验分两项：
  - `<pid>/search_documents`：文档行逐行比对。
  - `<pid>/search_documents.queries`：查询等价（05 §2.5）。每个实体类型取一份文档（entity_id 最小），抽四类探针：标题、正文各取第一个不含空白且至少 3 个字符的片段的前 3 个字符（走 FTS）；第一组相邻的两个汉字（扫表路径）；entity_key 本身（靠 LIKE）。每个探针在源上按 2.0 的项目搜索查（`project-activity-read-model.ts:158-170`，查 2.0 自己的 FTS 表），在目标上按 3.0 的 `match_docs` 查，两边命中的 entity_key 集合必须相同。2.0 的索引与文档不同步时，这一项就会红。
- **knowledge_fts**：3.0 从每个条目的 head revision 重建。`k/knowledge_fts` 比对被索引的文本列（title、aliases、tags、summary、use_when、applies_to、body）。`metadata` 是不参与匹配的展示数据，读取时再用条目行覆盖，所以不比。

## 检查

每项检查是一次源 / 目标反投影的规范化摘要比对（05 §5.1）。检查名写作 `<范围>/<表>[.<方面>]`，范围是 `r`、`k` 或项目 id。检查失败时，检查名就是 `failures()` 里的那一条。

- **errors / first_failure_locator**：摘要不等时再走一遍，按检查登记的主键列配对两边的行。`errors` 是只在源、只在目标、内容不同的行数之和。`first_failure_locator` 是第一处不一致（先按源的顺序找，其次是目标多出来的行），写成 `检查名(主键值,…)`。文本主键写成 JSON 字符串，超过 64 个字符截断；BLOB 只写长度；没有主键列的单行检查只写检查名。搜索探针的定位写成 `…queries(<实体类型>.<探针种类>)`，不写探针文本。
- **覆盖**：每个 `CONVERTED`、`REBUILT`、`REFERENCED` 的 DB 族实例至少要有一项检查，否则 `Report::uncovered()` 给出一条 `<族实例>: no check ran`，计入 `failures()`，在 report.json 里是 `coverage_gaps`。它由检查列表现算，所以没跑过 VERIFY 的空报告本身就不干净。
- **DROPPED 的 DB 族**也有检查的：
  - `schema_migrations`（R12 / K5 / P9）：源的迁移集合必须等于 `app_meta.converted_from` 记下的 1..=N。
  - 项目 `settings`（P8）：必须为空。
  - labels 两表由 N-02d / N-02e 的规则记录与附件核对（`NORMALIZATION.md`）。
  - 其余 X1 派生表只记源摘要。
- **源摘要**：每个 DB 族实例的主源表，全部列按主键排序，算 05 §5.1 的 `D(t)`（`Report::sources`），舍弃和重建的族也算。`business_digest` 用同一种摘要。

## 工作副本与来源证明（W3b3）

- **源文件本身不打开。** 每个源库先复制成工作副本：db 与 `-wal` 一起复制，`-shm` 不复制。工作副本放在目标库旁边的 `legacy-work/`，独立 VERIFY 另做一份，放在 `legacy-verify/`。下面这些都只在副本上做：
  - 第一次读取时恢复 WAL（07 IMPORT「WAL 只在副本里恢复」）；
  - `quick_check`；
  - 核对迁移来源；
  - 补迁移；
  - `foreign_key_check` 与登记完整性；
  - 最后合并 WAL、改回单文件，供只读挂载。

  成功后删掉工作副本；失败时留着，随 staging 丢弃。

- **迁移来源**：2.x 的 27 个迁移在编译时嵌入（`store/src/legacy/migrations.rs`），每个文件的 sha256 另外固定，用例核对两者与仓库文件一致。源里每一行 `schema_migrations` 按 2.0 `assertAppliedMigrations` 核对：
  - 版本必须在计划里，比转换器新的拒绝；
  - 名字（完整文件名）与 `content_sha256` 必须认得，0015 另外接受修订前原文件的历史 hash；
  - `hash_origin` 只能是 `APPLIED` 或 `LEGACY_BASELINE_UNVERIFIED`；
  - 低于最高版本的迁移都要在。
- **补迁移**：缺的迁移按 2.0 runner 的语义补跑：`foreign_keys = ON`，每个迁移一个事务，`schema_migrations` 写完整文件名、sha256、`APPLIED`，`applied_at` 取转换时刻 `at`。2.0 的升级前备份在这里不需要，原始快照本身就是。
- **来源证明**（`Report::provenance`，也写进 `app_meta.converted_from.sources`，同时记 `converterVersion`）：每个源库一条，包括：
  - `role`（`registry` / `knowledge` / `project:<id>`）；
  - 源 db 与 `-wal` 的 sha256；
  - 源里 `schema_migrations` 的原样内容；
  - 补跑的版本。

  VERIFY 把这一次读到的来源证明与目标里记下的比对（检查 `r/app_meta.sources`），所以转换之后源文件被改过也看得出来。

## 按数据根输入（W3b4）

`LegacySources::from_root(<L>)` 按 2.0 的布局取三类库，并带上数据根本身。给了数据根，转换和独立 VERIFY 都会处理文件族；没给数据根时，这些族都列在 `pending()`，提示为 `needs the data root`。

- **数据根枚举**（在动目标之前；`legacy/root.rs`）：
  - 每个顶层条目都必须命中族表，否则停；
  - `trash\` 非空就停；
  - 进行中的文件事务残留（`projects\.creating-*`、`*.creating`、`.restore-*`、`project.sqlite.restore-old-*`、`knowledge\` 里除库以外的文件）先拒绝，W3b6 落定之后才放行；
  - `registry\`、项目目录、`sync\`、`dispatch\` 里未登记的文件同样停。
- **R / X 类只登记数量**：每个族记文件数与总字节数，不读内容，`digest` 为 `null`。
- **附件（P11）**：`projects\<id>\artifacts\**` 逐文件复制到目标旁的 `artifacts\<id>\`，用检查 `<pid>/artifacts.files` 比对两边的 (相对路径, size, sha256) 集合，定位写第一个不一致的相对路径。
  - **改写**：`local_path` 指向本项目附件目录里的文件时，改写成 `data/artifacts/<id>/<相对路径>`（相对新根），原值留在 `legacy_local_path`。`artifacts` 表的逐行比对用 `legacy_local_path` 反投影。
  - **只记信息项的情况**：附件行指向附件目录之外（`local_path` 保留原值）；源文件本来就不在（「源缺失」）。
  - **停的情况**：源文件在、目标文件不在。行里的 size / sha256 与文件不一致只记信息项。
- **manifest（P10）**：`project_id`、`project_code`、`schema_version` 必须与 registry 一致（检查 `<pid>/manifest.json`），缺失或不是 JSON 也算不一致。名字不同只记信息项：2.0 改名时不回写 manifest。
- **备份（X7）**：
  - **登记**：目录表之外的 2.0 备份文件登记进 `legacy_backups`，id 为 `<source>:<相对路径>`，只算 sha256，不复制。包括三类：升级前备份 `pre-migration-v<n>-*.sqlite`（registry、knowledge、各项目的备份目录，带 `schema_version = n`）、知识恢复前的现库 `before-restore-<ULID>.sqlite`、知识恢复的孤儿件 `orphan-<ULID>-restore-<ULID>.sqlite`。
  - **核对**：所有登记的备份都要核对文件存在、sha256 与登记一致。缺失或不一致只记信息项（X 类）。
- **generation**：`ConvertOptions::generation` 由 07 的状态机传入，写进 `app_meta.generation`；不传时随机生成。

## 源副本与业务图（05 §3.3；W3b2）

- **源副本先过两项检查**（在工作副本上、写目标之前）：`PRAGMA quick_check` 必须是 `ok`；`foreign_key_check` 必须为空。违例时转换以 `Mismatch` 停下，并点名源文件、表、rowid 与父表。
- **业务图停级校验**（VERIFY，`Report::graph_violations`，计入 `failures()`）。在目标上按 project_id 查。源与目标逐族相等已经由摘要证明，所以在目标上查等于在源上查。每条写成 `<pid>/<表>.<方面>: <n> rows, first <主键>`：
  - `review_requests.review_work_item`：被审任务的 type 必须是 `REVIEW`；
  - `review_requests.parent_checklist`：父检查项属于父任务。提交引用的记录在同一项目，由目标的复合外键 `(project_id, record_id)` 保证，源上的悬空引用由 `foreign_key_check` 拦下；
  - `handoffs.checkpoint_sequence`：不超过项目序号；
  - `agent_sessions.parent_session_id`、`records.supersedes_id`：链不成环。`predecessor_session_id` 的同刻环是 N-05 允许的，不在这里查。
  - `counters.<名字>`：七个计数器在表里有编号时必须存在，并且大于最大编号；
  - `idempotency_keys.sequence`：回执 JSON 里任何键为 `sequence` 的整数不超过项目序号。不是合法 JSON 的回执按空数组展开。
  - `work_items.status`：等待中的 status（`WAITING_USER` / `WAITING_AGENT`）对应同名的 `waiting_on`，phase 不是 DONE / CANCELLED。其余 status 等于 phase，并且 `waiting_on` 为空。依据是 2.0 `work-item-lifecycle-commands.ts` 的写法：wait 不改 phase，其余操作同时写两列并清空 waiting_on。
- **信息项**（`Report::notes`，不停）：
  - 0015 的四个派生列按 2.0 的 SQL 在源上重算，结果不一致；
  - `SUPERSEDED` 记录没有 ACTIVE 的替代；
  - 知识修订号没有从 1 连续到 head；
  - 晋升的快任务解析到的任务，`source_quick_id` 没有指回它。
- 夹具 `rich_fixture` 让 05 §1 的每个 DB 族都有行（项目 settings 必须为空），包括 review 的三类（APPROVED、CHANGES_REQUESTED、未提交）和一个 TRASHED 项目。每项停级校验各有一个失败用例。

## report.json

`Report::report_json()` 输出一个 JSON 对象，W3d 写到 `staging\<g>\report.json`；附件另见 `Report::attachment_jsonl()`。只含表名、主键、计数与摘要，不含正文与密钥（用例 `report_json_lists_every_family_without_bodies`）。

```text
{
  "format": "atm-conversion-report", "version": 1,
  "knowledge": "PRESENT" | "MISSING",
  "families": [
    { "code": "P3", "family": "<范围>/<族名>", "decision": "...", "drop_reason": str|null,
      "business_digest": bool, "pending": "W3b4"|null,
      "source": { "path_class": "projects/<id>/project.sqlite", "rows"|"files": n|null, "digest": hex|null },
      "target": { "table"|"dir": str|null, "rows": n|null, "digest": hex|null },
      "checks": [ { "name": str, "result": "PASS"|"FAIL", "errors": n, "first_failure_locator": str|null } ] }
  ],
  "normalizations": [ { "rule": "N-05@1", "reason": "SAME_INSTANT"|null, "family": str, "count": n, "keys_digest": hex } ],
  "rule_mismatches": [str], "coverage_gaps": [str], "graph_violations": [str], "notes": [str],
  "receipts": { "classes": {…}, "promotion_shaped_agent": n, "promotion_status": {…}, "violations": [str] },
  "global_feed": { "orphans": n, "mirrors_replayed": n },
  "outbox_without_event": n, "unresolved_promotions": n, "artifact_rows": n
}
```

- 族实例：registry 与数据根各一份，有知识库时一份，每个项目一份（P1–P11 与项目的 X1）。
- `target.rows`、`target.digest` 取检查名与族实例名相同的那项检查（主检查），没有就是 `null`。
- 规则标识与原因的拆分见 `NORMALIZATION.md`「报告」。
