# 转换报告与对象族清单（05 §3.4、§5.2；W3b1）

转换器（`store/src/legacy.rs`）的报告按一张固定的对象族表组织。族表在 `store/src/legacy/families.rs`，用例 `the_family_table_matches_05_and_claims_every_2x_table` 按 05 逐行手抄期望值比对。

## 族表

- **编号**沿用 05 §5.2：R1–R12（registry）、K1–K5（knowledge）、P1–P11（每个项目）、F1–F7（数据根文件）。§5.2「显式排除」表的各行编为 X1–X12，顺序与表格相同。同一编号可以有多个族，例如 P3 是十四张表。
- **每张 2.x 表恰好归一个族**。FTS 的影子表（`_config/_content/_data/_docsize/_idx`）随主表归族。转换入口的登记完整性检查（`prepare_source`，在工作副本上）也用这张表，所以族表里少登记一张表，转换就拒绝这个源（`UnknownTable`）。
- **decision**：`CONVERTED`（逐行或逐文件进新库）、`REBUILT`（派生数据，在新库重建，查询等价）、`DROPPED`（不进新库，`drop_reason` 写理由）、`REFERENCED`（不复制，只登记引用）。
- **business_digest**：是否纳入回滚检测（05 §5.2「纳入」列）。X 类和 F7 不纳入。
- **pending**：W3b6 之后族表里没有未实现的族；不按数据根输入时，数据根下的文件族都算 pending（`needs the data root`）。`Report::pending()` 列出这些族实例，**W3d 的提交门要求它为空**：`conversion::run` 在 VERIFY 之后检查，不空就记 FAILED、不发布。

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

## sync 与 dispatch 文件（W3b5）

F1–F7 在给了数据根时处理（`legacy/jsonfiles.rs`）。**读盘**：先按 2.0 的读盘语义加载，再写进 3.0 的表；VERIFY 把目标表反投影成同一形状的 JSON，与源的加载结果比 JCS（RFC 8785）摘要。

- **zod 4 的规则照做**：
  - 非 strict 的对象丢掉未知键，`DispatchConfigSchema` 是 strict，多一个键就算不合法；
  - 数字必须有限，`int` 指安全整数；
  - 字符串长度按 UTF-16 码元算；
  - union 取第一个通过的分支；
  - 文件按 `readFileSync(…, "utf8")` 解码：坏字节换成 U+FFFD，BOM 保留，所以带 BOM 的文件 `JSON.parse` 失败。
- **超出接受域就停**：
  - 读不出来（不是「不存在」）；
  - 嵌套过深；
  - 字符串里有落单的代理项；
  - 水位线不是 `toISOString` 的形状（`Date.parse` 的完整语义不复现，不猜）；
  - run、请求或已处理命令重复；
  - `dispatch\logs\` 里有名字不合 `<run>.jsonl` / `<run>.stderr.log` 的文件，或有子目录。

  这些都在动目标之前，由数据根枚举时的那次加载拦下。

| 族                              | 目标                                                                                       | 要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 `sync\config.json`           | `sync_state`、`sync_processed`（`ord` = 数组下标）、`sync_published`（`head_json` 存 JCS） | **缺失或损坏时不写 `sync_state`**，而不是写默认值。2.0 会把坏文件改名留档，下次启动从默认值开始；默认值的 deviceId 是随机的、deviceName 取主机名，3.0 首启同样生成。损坏时记信息项。                                                                                                                                                                                                                                                                                                                |
| F2 `sync\secrets.dpapi.json`    | 目标旁的 `sync\secrets.dpapi.json`                                                         | **逐字节复制**，sha256 相等。<br>**DPAPI 自检**：由宿主通过 `ConvertOptions::secrets_check` 给出，在动目标之前做；存储包不碰 DPAPI。<br>**停的情况**：没给自检函数；自检解不开（换了 Windows 账户或机器，手机配对要重做）。                                                                                                                                                                                                                                                                         |
| F3 `dispatch\config.json`       | `dispatch_config`                                                                          | 不存在 → 默认值、`MISSING`；坏 JSON 或不合法 → 默认值、`CORRUPT_DEFAULTED`（2.0 不重写它，记信息项）。                                                                                                                                                                                                                                                                                                                                                                                              |
| F4 `dispatch\runs.json`         | `dispatch_runs`、`dispatch_meta.requests_since` / `runs_damaged_at_conversion`             | `loadRuns`：逐条校验，坏条目丢弃并置 damaged；整个文件坏了从空历史开始。<br>**exitCode**：2.0 的 `exitCode` 有三态，用 `exit_code` + `exit_code_set` 保留。<br>**task_id**：按 R5 补上，解析不到的计数进信息项。<br>**log_root**：运行中的 run 是 `LEGACY`，其余是 `CURRENT`。                                                                                                                                                                                                                      |
| F5 `dispatch\requests.json`     | `dispatch_requests`、`dispatch_meta.lost_before`                                           | 照做 `loadLedgerFile` 和 `RequestLedger#reload`。<br>**丢失时**：文件损坏、有坏条目，或者文件缺失而历史显示用过手机派单（含历史损坏），这时 `lost_before = max(文件里的水位线, at)`。<br>**补回**：带 requestId 的历史补回成精确条目（`snapshotOf(toRunView(record))`）；同一个 requestId 有多条时取创建时间最近的。<br>**不做的事**：不裁剪、不补 `requestsSince`。那是 2.0 下次读盘时按当时的时钟做的，3.0 运行时按自己的时钟裁剪。丢失判断不一样：转换之后就观察不到了，所以按 `at` 落成水位线。 |
| F6 `dispatch\logs\`（非运行中） | 目标旁的 `dispatch\logs\`                                                                  | 复制。检查 `r/dispatch.logs` 比 (名, size, sha256) 集合。                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| F7 `dispatch\logs\`（运行中）   | 原地                                                                                       | 子进程还在旧根里写，不复制，只登记数量；对应 run 的 `log_root` 必须是 `LEGACY`（图检查）。                                                                                                                                                                                                                                                                                                                                                                                                          |

- **检查**：`r/sync.config`、`r/sync.secrets`、`r/dispatch.config`、`r/dispatch.runs`、`r/dispatch.requests`、`r/dispatch.logs`。
  - **定位**：runs 写 `r/dispatch.runs("<run>")`，请求写 `r/dispatch.requests("<id>")`；不属于某个元素的差异（damaged、水位线）只写检查名。
  - **反投影的比较顺序**：runs 按 run 排，请求按 id 排，`processed` 保持原序。
- **源摘要**：`business_digest` 用 `{parseState, value}` 的 JCS 摘要，`parseState ∈ {OK, MISSING, CORRUPT}`，状态不同即「变了」。F5 的源摘要只算文件本身，不含 `at` 与补回的条目；F7 只登记数量。
- **图检查**：`log_root` 与 run 的状态不符；`task_id` 指向的任务的公开 key 与 `task_key` 不符。两者都是停级违例。
- **X9**：历史里没有的 run 的日志（被裁剪的、坏条目的），2.0 下次保存历史就删，记 X9，不复制。

## 进行中文件事务的落定（W3b6）

给了数据根时，转换先在工作副本上照做 2.0 的启动恢复（`legacy/settle.rs`），源文件只读不开。独立 VERIFY 用同一个 `at` 重做一遍，结果必须相同。每一项落定记进 `Report::settlements`，`report.json` 里是 `settlements: [{scope, was, now, how}]`。

| 残留                     | 落定（与 2.0 一样）                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 依据                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `knowledge\restore.json` | `committed=false` 且 `backups\knowledge\before-restore-<id>.sqlite` 在：它是现库（`ROLLED_BACK`），不再登记成备份。否则现库为准（`COMMITTED`）。<br>候选件 `restore-<id>.sqlite` 丢弃；别的 `restore-<ULID>.sqlite` 是孤儿，按原位置登记进 `legacy_backups`（`KNOWLEDGE_ORPHAN`）。<br>日志读不出、不是对象、id 不是 ULID、committed 不是布尔：2.0 让知识库不可用，这里停。                                                                                            | `knowledge-restore.ts:28-75`  |
| `CREATING`               | `projects\<id>\project.sqlite` 通过 `quick_check` → ACTIVE，写 `db_path`。这时 manifest 可能还没写，2.0 之后也不补写，缺失只记信息项。<br>否则 TRASHED，只有 registry 那一行，没有项目数据。                                                                                                                                                                                                                                                                           | `startup-recovery.ts:81-103`  |
| `RESTORING`              | 名字以 `project.sqlite.restore-old-` 开头的文件按名排序，从后往前取第一个健康的作为现库 → ACTIVE。没有回滚件且现库健康 → ACTIVE。否则 MIGRATION_FAILED，再走下一行。<br>选中的回滚件带非空 `-wal` 时停：2.0 只改名主文件，这里无法如实复现。                                                                                                                                                                                                                           | `startup-recovery.ts:122-146` |
| ACTIVE 却有回滚件        | 现库为准，回滚件丢弃                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `startup-recovery.ts:147-150` |
| `MIGRATION_FAILED`       | 库在且非空：在副本上补迁移、核对 `project_meta` 的身份 → ACTIVE，并追加全局事件 `project.migration_recovered`（dedupe 键已在就不追加）。<br>做不到：整体转换失败，点名项目，不悄悄跳过。<br>**舍弃**：用户用 `ConvertOptions::accept_unconvertible`（W4 的 `migrate --accept-unconvertible <code>`）显式点名时，项目进回收站且没有数据，原库按原位置登记进 `legacy_backups`（`UNCONVERTIBLE_PROJECT`，可日后单独导入）。点名的码没有对应的 MIGRATION_FAILED 项目时停。 | `manager.ts:315-356`          |

- **registry 工作副本上的改动**：lifecycle、`updated_at = at`、CREATING 的 `db_path`、全局事件与 `app_meta.current_sequence`。
- **备份目录里的 `.pending`、`.delete-pending`、`*.tmp*`**：2.0 启动时清掉，这里只计入 X7，不登记、不复制。
- **残留件本身记 X12，不复制**：`.creating-*`、`*.creating`、`.restore-*` 目录，回滚件，知识库的日志与候选件。
- **没给数据根时**：看不到回滚件和日志，进行中的生命周期照旧拒绝。

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

## business_digest 与幂等重放（W3c）

- **`Report::business_digest()`**：返回 `<范围>/<族名>` → 摘要。
  - 取值就是 VERIFY 的源摘要，用同一套规范化；只取族表里 `business_digest` 为真的族。
  - 不在里面的：只登记数量的 R / X 类、F7、重建的索引。
  - 07 §3 VERIFY 把它写进清单 `M`。
- **`legacy::business_digest(src, scratch, opts)`**：07 §6 回滚检测时，对数据根重算一遍。
  - **怎么算**：按转换同样的流程（工作副本、落定、规范化）在 `scratch\business-digest\` 里转换一次，取摘要，然后整个删掉；`L` 只读。
  - **`opts.at`**：必须用转换时的那一个，因为落定会把它写进 registry 的工作副本。
  - **出错时**：读失败、出现未登记的文件或表、超出接受域、源与目标对不上，都返回错误，调用方按 UNKNOWN 处理。
- **不变量**（用例 `business_digest_ignores_storage_and_follows_business_changes`）：
  - 不受影响：VACUUM、换成 WAL 并留着没合并的 `-wal` / `-shm`、只动空白的 JSON、R / X 类文件的变化；
  - 恰好对应的族变：改一行、改一个配置值、改附件的一个字节。
- **幂等重放模拟**（`service/tests/legacy_replay.rs`）：
  - **夹具**：一个 2.x 项目库，里面的旧回执用 kernel-v1 从真实请求算指纹。
  - **验证**：转换后由服务按同一个 session 与 op_id 重发，必须 REPLAY 出保存的结果；请求不同则 `IDEMPOTENCY_CONFLICT`；新的 op_id 照常写入，序号接着 2.x 往后排。
- **报告不含凭据与正文**：`report.json` 只有表名、主键、计数与摘要（用例 `the_report_carries_no_credentials_or_bodies`）。正文只在单独存放的附件里。

## 转换状态机（W3d，`src/conversion.rs`）

按 07 §1–§5 实现。只管文件与状态，进程级的事（单实例、旧版是否静止、起不起入口）交给宿主，这里只给判定。

- **布局**（`N` 是新根）：
  - 清单 `M` = `conversion.json`，权威记录 `A` = `authority.json`，都先写临时文件、刷盘再改名。
  - `staging\<g>\` 放一次尝试：`src\`（快照）、`data\`（转换结果）、`report.json`。
  - 发布物 `data\`：`atm.sqlite` 与旁边的 `artifacts\`、`sync\`、`dispatch\`，由 `staging\<g>\data\` 整体改名而来。
  - `quarantine\`、`superseded\`；`runtime\service.lock`（准入）、`runtime\seal.json`（进行中的封存）。
- **准入 `admit`**：
  - 先对 `service.lock` 做 `File::try_lock`，拿不到就是 `AlreadyRunning`。
  - 再问宿主注入的闭包，旧版没静止就是 `WaitLegacyQuiesce`，同时放掉 lease。
- **快照 `legacy::snapshot_files`**：只装业务文件，即 registry、knowledge、项目目录（不含 `backups\`）、sync 的两份配置、dispatch 的三份 json 与非运行中的日志，有知识恢复日志时再加它的 before-restore 文件。
  - 不进快照：其余备份、R / X 类、运行中的日志。备份按原始根只读登记；运行中的日志 `log_root = LEGACY`，留在原地。
  - 在快照上转换时 `origin_root = L`。数据根的枚举、未登记条目的守卫、R / X 类计数、运行中日志的计数、登记的路径都看原始根，所以报告与直接在 `L` 上转换逐字节相同（用例 `a_snapshot_conversion_publishes_and_leaves_the_2x_root_untouched`）。
- **`run`**：
  - **SNAPSHOT**：枚举 F0、复制、再枚举 F1，F0 ≠ F1 或副本的 sha256 与 F0 不符都记 `FAILED` 与原因，不发布。
  - **IMPORT / VERIFY**：在快照上转换并做独立 VERIFY；`report.json` 与 `attachment.jsonl` 写进 staging，`report.json` 的 sha256 记作 `verify_digest`，同时写 `business_digest`。
  - **提交门**：`Report::pending()` 不空就记 FAILED、不发布（用例 `conversion::tests::a_report_with_pending_families_is_not_publishable`）。
  - **PUBLISHING**：库合并 WAL、改回 DELETE 日志模式；算出 `publication_digest`（只取 `artifacts\`、`sync\`、`dispatch\` 三个子树；库旁边实测会冒出别的程序的 `ATM.SQLITE-SHM.tmp`，随建随删还被占着，不算发布物，列出后消失的文件也跳过）；先写 `M`，再整体改名。
  - **PUBLISHED**：先写 `M`，再写 `A = v3 by publish`（绑定 generation），最后删掉源副本。
  - SNAPSHOT 之后数据根再变不影响这一次（用例 `the_conversion_reads_the_snapshot_not_the_live_root`）。
- **S1 `fresh_install`**：建空库、种 `app_meta`，走同样的 PUBLISHING → PUBLISHED；`M.source_root = null`，`A = v3 by publish`。
- **改名**：`M`、`A` 的替换、发布、封存都走 `MoveFileExW(WRITE_THROUGH)`，改名落盘之后才返回，这一步就是规格里的「fsync 目录」（Windows 上目录不能单独 fsync）。
  - 发布与封存不带 `REPLACE_EXISTING`，目标已存在就失败。
  - 刚写完的文件常被杀毒软件或索引器短暂占用，改名会返回 5 / 32 / 33。遇到这几种错误退避重试约 10 秒。变异运行里实际撞到过 32。
  - 这段重试和 WRITE_THROUGH 标志没有确定性的用例能验红，属于已知的未覆盖项。
- **启动判定 `decide`**：
  - **ResumeSeal**：有进行中的封存，先续做。
  - **S1 / S2**：没有 `M`，也没有发布物。
  - **S3**：SNAPSHOT / IMPORT / VERIFY / FAILED，或停在 PUBLISHING 但还没改名。
  - **S4**：PUBLISHING，库内 generation 一致，且实际读出的文件摘要等于 `M` 里的摘要。读不出来不算相等（W3 peer r1 P1-04）。
  - **S6**：PUBLISHED，且库内 generation 一致。只比 generation，因为发布后服务会写附件。
  - **一律隔离**：`M` 缺失或损坏时有发布物（S5，不打开发布物）；generation 不符；PUBLISHING 时文件被动过或读不出来；还没到 PUBLISHING 就有发布物。
  - **`M` 损坏**：除了读不出、形状不对，还包括摘要不是 64 位小写十六进制，以及 PUBLISHING / PUBLISHED 没有 `publication_digest`。
- **封存 / 隔离 `seal`**：
  - **先写意图**：把种类与目标名写进 `seal.json` 再动手；中断后再调用，以意图为准续做。
  - **不覆盖**：目标名撞了加后缀；目标里已有 `data\` 就移到 `data-2\`。
  - **`M`、`A` 的副本**（W3 peer r1 P1-02）：原子写（临时文件、刷盘、改名），写完读回核对。重入时目标已在：
    - 与原件相同就跳过；
    - 是原件的真前缀（早先复制了一半）就重写；
    - 其余（另一份完整内容）拒绝，不覆盖。
      原件只在两份副本都核对完整之后才删；任何一步失败，原件和意图文件都留着，下次启动还是续做封存。
  - **封存与隔离的区别**：封存先尝试 `wal_checkpoint(TRUNCATE)`，隔离绝不打开库。
- **用例**：`legacy.rs` 的 `w3d::*`，每个注入点中断后的续跑、源不静止、不可信发布物、封存被杀两次、准入、`M` / `A` 的形状。
- **变异**：`output/w3-evidence/w3d-mutation-evidence.json`。

## 权威判定与数据源冲突（W3e，`src/conversion.rs`）

按 07 §6–§7 实现。何时比较、什么时候停入口由宿主决定，这里提供判定和状态。

- **`must_compare_before_serving(A, M)`**：`A` 不是一条与 `M.generation` 对得上的 v3 记录时为真，即发布任何入口之前必须阻塞比较。否则服务照常启动，比较放到后台做。
- **`compare(N, M, 基准, L)`** 返回四种结果之一：不变、变了（列出不等的族）、UNKNOWN（带原因）、`L` 已不存在。
  - **基准**：取 `baseline(M, A)`，用户选过「沿用 3.0」就是当时接受的摘要，否则是 `M.business_digest`。
  - **怎么算**：在 `N\runtime\compare\` 里按 SNAPSHOT 同样的方式只读快照 `L`，再用转换时的 `at`、当时点名舍弃的项目（`M.accepted_unconvertible`），按转换的同一流程重算 business_digest'，用完删掉。
  - **舍弃许可绑定内容**（W3 peer r1 P1-05）：
    - 舍弃的项目在 business_digest 里有一族 `dropped/<id>`，是它 `projects\<id>\` 目录下文件集合的摘要。原坏库不动，比较稳定；内容一动就是「变了」。
    - 落定对点名舍弃的项目也先按 2.0 的重试走一遍（不落状态）。重试能恢复就拒绝舍弃，比较时就得到 UNKNOWN。旧许可不能拿来丢掉现在恢复得了的数据（05 §4.1）。
  - **只看业务内容**：VACUUM、R / X 类文件都不算变（用例 `compare_tells_unchanged_changed_unknown_and_gone_apart`）。
  - **两边族集合不同**（2.x 里新建或删掉了项目）也算变了。
- **`judge(A, M, L, 比较结果)`**：判定表如下（用例 `the_authority_table_has_a_case_for_every_cell`）。

  | `A`    | 比较                | 结果                                                   |
  | ------ | ------------------- | ------------------------------------------------------ |
  | v3     | 不变；`L` 不在了    | Serve                                                  |
  | v3     | 变了；UNKNOWN       | Conflict                                               |
  | legacy | 不变                | ResumeAfterRollback（`A=v3 by resume-after-rollback`） |
  | legacy | 变了                | Reconvert（封存后走 S2）                               |
  | legacy | UNKNOWN；`L` 不在了 | Conflict                                               |

  B3：`A` 缺失、损坏、绑定的 generation 与 `M` 不符，或 `M.source_root` 不是这次的 `L`（按 Windows 规则不分大小写），一律冲突，不猜。

- **回滚记录 `rollback_authority`**：给 setup 用。写 `A=legacy by setup-rollback`，带上 generation 和已接受的摘要；否则用户选过「沿用 3.0」之后回滚、又没动 2.x，也会被当成「变了」而重转。`resume_after_rollback` 同样沿用这份摘要。
- **冲突状态**：
  - `enter_conflict` 写 `N\runtime\startup-state.json`，内容是 `{state: "SOURCE_CONFLICT", since, generation, reason}`，不含凭据。重复进入时保留原来的 `since`。
  - `decide` 对这个 generation 返回 `SourceConflict`，宿主不起任何入口。文件损坏也按冲突处理，不放行。
  - 新的一次 `run` 或 `fresh_install` 开始时清掉旧状态。
  - 用例 `a_source_conflict_holds_back_the_service_and_writes_nothing` 验证冲突期间发布物和 2.x 都一个字节不变。
- **用户的两个选择**（只认 User，B2 由调用方保证）：
  - **`choose_v3`**：写 `A=v3 by user-choice`，绑定这次算出的摘要，然后清掉冲突状态。之后 2.x 不动就照常启动，再写入还能识别出来（用例 `accepting_3_0_binds_the_digest_and_later_2x_writes_are_seen_again`）。先写 `A` 再清状态：中间被杀，下次启动会再问一次。
  - **`choose_legacy`**：整个 generation 封存进 `superseded\`，之后走 S2。
- **UNKNOWN 时选「沿用 3.0」只放行当次**（W3 peer r1 P1-01 推翻了原来的取舍）：
  - 没有完整摘要，就没有可以绑定的东西。`A` 沿用同一 generation 下之前接受过的摘要，没有就是 `None`，以 `M.business_digest` 为准。
  - 下一次比较仍是 UNKNOWN 就再冲突，原因相同也一样。原来记下原因、同一原因不再打扰的做法，会让原因不变期间 2.x 的新写入整个被放过（评审反例：未登记文件原样留着，registry 里改了项目描述，仍判 Serve）。
  - **代价**：原因不消除，每次启动都会问。冲突状态里带着原因（例如未登记的文件名），用户可以去掉它；也可以选「从 2.x 重新转换」。
- **`L` 不在了**（用户删了 2.x 数据）：v3 照常启动；legacy 判冲突，因为选了 2.x 为准，它的数据却没了。
- **变异**：`output/w3-evidence/w3e-mutation-evidence.json`。

## 与 setup 的启动交接（W3f）

按 07 §8 实现，分在三处：

- **格式与判定**：在 `install-state/src/startup.rs`。setup 与新进程共用这一份，免得各写一份、慢慢对不上。
- **进度上报**：在本包。
- **接入**：在 `setup/src/txn.rs` 与 `setup/src/reverse.rs`。

- **进度上报**：`RunOptions.progress` 回调 `(阶段, 已完成, 总数, 工作量)`（`src/progress.rs`；W4a 起加了工作量，见「W4a」一节）。
  - 首条是 SNAPSHOT 0/0，在任何枚举之前；SNAPSHOT 按文件报；IMPORT、VERIFY 按项目报（`ConvertOptions.progress`），开始时各报一次 0；PUBLISHING、PUBLISHED 各报一次。
  - 其间每做完一个有界的工作批次，工作量加一。
  - 宿主把它写成 `N\runtime\startup-progress.json`，内容是 `{txn, pid, process_created_at, generation, phase, progress{done, total, work}, updated_at}`。
  - 用例 `w3f::conversion_progress_reaches_setup_but_is_not_health` 把转换报的每一条交给 setup 的判定，确认一路都是「继续等」，阶段依次是 SNAPSHOT → IMPORT → VERIFY → PUBLISHING → PUBLISHED。
- **setup 的等待 `ProgressWatch`**：
  - **健康**：只认 SERVICE_HEALTHY 见证。进度报到 PUBLISHED 10/10 也只是「在等」。
  - **只认本次**：只接受本次 txn、本次进程（pid 与创建时间都对得上）写的进度。
  - **三档时限**：一条可接受的进度都没有时，60 s 判失败，不转换的启动与原来一样。有过进度后，10 min 没动判卡住；只刷新 `updated_at` 不算动。总上限 2 h。
  - **进程死亡**：立即判死。
  - F15–F18 各有用例，在 install-state 的 `startup::tests`。
- **回滚 `settle_for_rollback`**：
  - **前提**：新进程必须已放掉 `N\runtime\service.lock`，否则拒绝。
  - **按 `M` 的实际阶段处理**：没转换、没发布、`M` 读不出都不写 `A`；已经 PUBLISHED 就写 `A={legacy, setup-rollback, txn, at, generation}`。
  - **接受过的摘要**：同一 generation 下用户接受过的摘要会一并带上。
  - **契约**：写出的记录与本包 `rollback_authority` 逐字段一致，判定照常走「无损接回」（用例 `w3f::setups_rollback_record_is_the_one_the_store_expects`）。
- **setup 接入**：
  - **START**：改为按 `WaitPolicy` 等。接管别的 setup 启动的进程时，首条进度的窗口仍是原来的 20 s。
  - **写 `A` 的时机**：都在切换版本之前。
    - 撤销一次到 3.x 的升级：UNDO 第 1 步停掉新进程之后。
    - 从 3.x 主动回滚或降级：SWITCH 之前。
    - 从 3.x 回到 Electron：R_POINTER 之前。
  - **setup 重启时**：3.x 的 START 若发现自己启动的进程还活着，就接管等待，不再直接回滚。
  - **新根位置**：`ATM3_DATA_DIR` 覆盖，否则 `%LOCALAPPDATA%\AyanamiTaskManager3`。演练沙箱没指定时放在沙箱里。
- **未覆盖**：setup 侧这几处接入目前只有编译与 clippy 保证，没有端到端用例。要等 3.x 的宿主（W4 起）能真的写进度、起服务，才能在演练里跑通（W3h / W8）。
- **变异**：`output/w3-evidence/w3f-mutation-evidence.json`（install-state）、`w3f-store-mutation-evidence.json`（本包）。

## dry-run（W3g，`conversion::dry_run`）

07 §9 `atm.exe migrate --dry-run --source <L> --out <dir>` 的库入口。CLI 外壳在 W6。

- **动手之前先拒绝**（`Error::Refused`）：
  - 输出目录不是空的；
  - 与 `L` 或 `N` 重叠：任一方向的包含，按真实位置判断（W3 peer r1 P1-03）。
    - 怎么判断：最近一个已存在的祖先 `canonicalize`（跟随 junction 与符号链接），再接上不存在的部分，不分大小写比较；
    - 输出目录建好之后取它的真实路径再查一次，之后的写入都落在这个真实路径上。
- **源未静止只报告**：
  - 旧版在跑或判定不了（注入的静止判定，规则同 §2）：返回 `SourceBusy`，连输出目录都不建。
  - SNAPSHOT 期间源在变：返回 `SourceNotQuiet`，复制了一半的东西清掉，不出报告。
- **执行**：在 `out\src\` 快照，在 `out\data\` 转换并做独立 VERIFY。登记路径按 `L`，所以报告与直接转换逐字节相同。
  - **输出**：留下 `report.json` 和 `attachment.jsonl`。源副本总是删掉；转换出的库默认也删，因为里面是用户数据，`keep_data` 时保留。
  - **VERIFY 不过**：报告照写，返回 `VerifyFailed(失败的族)`。
- **不写 `N`**：`M`、`A`、启动状态、进度一概不碰，也不起任何调度器。
- **目录身份**（W3 peer r2 P1-R2-01，`src/pin.rs`）：
  - 输出目录、它的祖先、`src`、`data` 以及 `src` 下的每层目录，在整个写入与清理期间都被句柄钉住：持有句柄，共享方式不含 `FILE_SHARE_DELETE`。钉住的目录不能改名、不能删除，它的祖先也不能改名，所以按句柄的最终路径写入时，到达的就是钉住的那个目录。
  - 静止判定之后才钉住：先钉住最近一个已存在的祖先，按它的真实位置再查一次与 `L`、`N` 的重叠，然后才建目录。缺的每一层都用 `NtCreateFile(FILE_CREATE)` 相对父目录句柄排他新建；名字被目录、文件或 junction 占着就失败。已存在的输出目录在钉住之后再查一次是否为空。
  - 文件（快照副本、报告的临时文件）一律排他新建，名字被占就失败，不会经过别人放在那里的硬链接写出去。
  - 报告的临时文件从新建到改名一直开着（W3 peer r4 P1-R4-01）：句柄带 DELETE 权限、共享方式不含 `FILE_SHARE_DELETE`，这段时间里别人改不了它的名、删不掉它。改名（不替换已有的名字）与失败时的丢弃都按句柄做，不按路径。
  - 清理只删本次排他新建的东西，而且按身份删（W3 peer r3 P1-R3-01）：
    - 快照副本的文件新建时记下（卷序列号, 文件号）。删除时不跟随链接地重新打开，身份一致才删。
    - `src` 下的目录由深到浅删。删的时候先放开钉住，再不跟随链接地重新打开，文件号与新建时一致、而且目录已经空了才删。
    - 不认识的条目一律不碰，包括放进来的 junction、挪进来的目录、换掉的文件。哪一处删不掉，它和它的每一层祖先都原样留下。
    - 别的程序（杀毒、索引）短暂开着某个副本时，删除会遇到共享冲突：退避重试约 2 秒，仍不行才算留下（W3 peer r4 P2-R4-01）。
    - 清理没做完时，dry-run 返回 `Error::CleanupIncomplete { left, outcome }`，不报成功：`left` 列出留下的位置，`outcome` 是清理之前的结果。
  - `data` 整棵删：条目不跟随链接，目录本身同样按文件号核对。删不掉也记进 `CleanupIncomplete`。
  - **边界**：`data` 里面由转换器自己建的目录（`legacy-work`、`legacy-verify`、附件）按路径读写，和正式转换在 staging 里的做法相同。它们都在本次新建并钉住的 `data` 之下，别的程序不知道这些名字。同一用户下有意篡改的进程本来就能直接写 `L` 和 `N`，不在防护范围内。这里防的是：用户给的路径及其祖先在检查之后被改名或换成链接（同步工具、脚本、并发操作）。
- **用例**：`legacy.rs` 的 `w3g::*`。`L` 一个字节都不变，`N` 不被创建。目录替换的用例见「W3 整体评审第二轮」。
- **变异**：`output/w3-evidence/w3g-mutation-evidence.json`。

## 故障注入矩阵 F1–F29（W3h）

07 §10 每一项一个用例，在 `legacy.rs` 的 `fault_matrix::fNN_*`。

- **每项都断言三件事**：
  - 选中的分支正确；
  - 没被选中的一边完整：封存物、隔离物与封存前逐字节相同，冲突期间 3.0 写的数据还在；
  - `L` 的业务对象集合没有被转换器改动。用转换的同一流程只读算 business_digest；用例自己模拟的 2.x 写入除外，比的是写入之后的那一份。凡是用例没动 `L` 的，再加一条整棵目录树逐字节相同。
- **几项的造法**：
  - F4 往项目库塞一条自相矛盾的旧回执，让 VERIFY 失败，报告点名 `S1:x1`；
  - F8 在 IMPORT 时把 `staging\<g>\data` 占成文件，模拟磁盘写不进；
  - F9 把一个项目库写成垃圾，失败原因点名 `P2`；
  - F10 VACUUM 加切 WAL，并留着连接；
  - F26 / F27 改成同样长度的内容，再把 mtime 改回原样；
  - F28 以 `share_mode(0)` 独占一个源文件；
  - F15–F18 把真实转换写出的进度文件逐条交给 setup 的 `ProgressWatch`。
- **为 F8 补的能力**：`run` 拆成 `run` 加 `attempt`。PUBLISHING 之前的任何失败（不只 SNAPSHOT 与转换器自己的错误）都记 FAILED 和原因。已经在 PUBLISHING 的不改：改名前失败按 S3 重来，改名后按 S4 认发布物。
- **变异**：`output/w3-evidence/w3h-mutation-evidence.json`，21 条。F15–F18 的变异落在 install-state，由这里的矩阵用例杀死。首跑有一条存活：「重启保留旧 M」。原因是 F2 只看重启后能发布，而下一次转换反正会覆盖 M。F2 现在在 `discard_attempt` 之后断言回到 FirstConversion。
- **没有用例的分支**（W3 时）：PUBLISHING 阶段、改名之前的非中断失败（例如改名本身失败）。W4a 补上了注入点与用例，见「W4a」一节的 P2-05。
- **范围的限度**（W3 peer r1 P2-05 指出）：
  - F2 停在复制完成之后，F3 停在 IMPORT 写数据之前，都没有造出复制了一半或事务中途死掉的状态；
  - F8 用文件占住 `data` 目录，造的是建不了目录，不是磁盘满或写了一半。
    这些和 PUBLISHING 的非中断失败一起，归入 W4 接线前的硬性验收。

## W3 整体评审第一轮（`output/peer-atm3-w3-r1.md`）

五条 P1 已在本轮修订，各节已同步：

| 编号  | 问题                                                    | 修订                                                                                 |
| ----- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| P1-01 | 接受 UNKNOWN 的原因文本，会遮住之后的业务写入           | 删掉 `accepted_unknown`；v3 遇到 UNKNOWN 一律冲突（「权威判定」一节）                |
| P1-02 | 封存重入把残缺的 `M` / `A` 副本当完整，删掉唯一完整原件 | 副本原子写、读回核对、残缺件重写、不同内容拒绝；核对完整后才删原件（「转换状态机」） |
| P1-03 | dry-run 的路径检查被 junction 绕过                      | 按真实位置判断两个方向的重叠，建目录后再查一次并在真实路径上写（「dry-run」）        |
| P1-04 | S4 把两个「没有摘要」当相等                             | `M` 按阶段校验摘要；只有读得出的实际摘要等于合法摘要才认（「转换状态机」）           |
| P1-05 | 旧的舍弃许可永久排除已可恢复的项目                      | `dropped/<id>` 族绑定内容；能恢复的项目拒绝舍弃（「权威判定」一节）                  |

- **用例**：`legacy.rs` 的 `w3_peer_r1::*`，包含评审的反例，以及同类的其他通道（读不了的源文件、两份副本之间被杀、副本落不下、junction 指向 `L`、`out` 是尚不存在的 `N` 的祖先、`M` 的各种坏摘要、还没修好但内容动了）。
- **变异**：`output/w3-evidence/w3r1-mutation-evidence.json`。
- **P2 的验收关口**（评审定的，不在本阶段收口）：
  - **P2-01**：VERIFY 独立核对 `project_paths.path_key`、`artifacts.local_path` 等派生列与源路径的映射。W4 使用转换输出之前完成。
  - **P2-02**：setup 与真实自有进程的交接（START、接管、死亡、取消、超时、写 `A` 与切换的顺序），以及 `ProgressWatch` 按本次启动累计的总预算；源身份不符要在开放入口之前拦住。W4 首次接线时完成，W8 做安装与回滚全流程。
  - **P2-03**：枚举、复制、迁移、IMPORT、VERIFY 按有界批次报进度，首条进度在开始枚举之前报。W4 之前完成。
  - **P2-04**：store 与 setup 统一持久化契约（逐文件刷盘、元数据提交、`A` 的写入顺序），改名标志与重试要有确定性用例。W4 发布与回滚接线之前完成，掉电实验放 W8。
  - **P2-05**：故障矩阵的范围见上一节；变异证据区分历史证据与最终候选证据，锚点随代码更新（本轮已把全部 W3 脚本的锚点对齐到当前代码并重跑）。

## W3 整体评审第二轮（`output/peer-atm3-w3-r2.md`）

| 编号     | 问题                                                                                                            | 修订                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| P1-R2-01 | dry-run 检查之后，输出目录的父目录或输出目录自己被换成指向 `N` 的 junction：目录建进 `N`，错误清理删掉 `N/data` | 钉住目录、排他新建、按文件号核对后才清理（「dry-run」一节的「目录身份」） |

- **用例**：`legacy.rs` 的 `w3_peer_r2::*` 与 `pin::tests::*`。
  - 评审的两个反例都在其中，并扩展到同类的其他通道。指向 `N` 和指向 `L` 各跑一遍，逐个断言两个根的文件内容与目录集合都不变。
  - 钉住之前被换：父目录、更上层还不存在的祖先、已存在的空输出目录自己、空输出目录里被放进的 `src`，一律拒绝，根里也不会建出目录。
  - 钉住之后被换：输出目录的父目录、输出目录自己、`src`、`src\dispatch`、`src\dispatch\logs`，改名都失败，dry-run 照常完成，报告写在原处。
  - 名字被提前占住：`data` 被占成 junction，或报告的临时文件名被占成指向 `N` 里文件的硬链接。都失败，不经过它们写入。
  - 清理时遇到放进 `src` 的 junction：第二轮的做法是只删链接本身；第三轮改为原样留下并报告，见下一节。
  - 原语层面：钉住的目录与它的祖先改不了名；排他新建不复用任何已有的名字；文件号对不上就不删。
- **变异**：`output/w3-evidence/w3r2-mutation-evidence.json`。
- **新增的 P2 关口**（评审定的）：
  - **P2-06**：`dropped/<id>` 的摘要含 WAL/SHM 的物理字节，checkpoint 或正常关库之后会误报 Changed。要在 W4 用这个比较驱动入口或自动重转之前修好，改成按逻辑内容取摘要。已修，见「W4 前的 P2 关口」。
  - **P2-07**：W3i 只证明构造出的副本能转换。要在 W4 接真实入口之前补齐：复制集合从 `snapshot_files` 导出，保持原路径身份，失败时非零退出。在那之前，W3i 的结论只写成「真实数据的逻辑副本演练通过」。已修，见「W4 前的 P2 关口」。

## W3 整体评审第三轮（`output/peer0519-tmp/codex-w3-r3.log`）

评审在写出报告之前被评审方自己的内容过滤中断。中断前，它已在日志里给出一条 P1 和复现用例（`output/peer0519-tmp/w3-r3/peer-r3-tests.rs`）。

| 编号     | 问题                                                                                                                                                                                                                   | 修订                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-R3-01 | 清理时，放开 `src\dispatch\logs` 的钉住到按文件号重开之间，把一个已有的、有内容的目录换进来。身份核对拒绝删除它，但错误被吞掉了；随后删父目录时又先枚举、整棵删掉里面的条目，换进来的内容被删，dry-run 仍报 `Verified` | 只删本次建的文件与目录，都按身份；目录只在空时删；删不掉的连同祖先原样留下；清理没做完返回 `CleanupIncomplete`（「dry-run」一节的「目录身份」） |

- **用例**：
  - `legacy.rs` 的 `w3_peer_r2::cleanup_leaves_what_it_did_not_create`：成功、源未静止、副本被换三条路。`src` 里放进指向 `L` 与 `N` 的 junction，挪进一个已有的有内容目录，换掉一份副本文件，这些都原样留下；结果是 `CleanupIncomplete`；`L` 与 `N` 不变。
  - `conversion::tests::a_replaced_directory_keeps_itself_and_every_ancestor`：确定性地造出「重开时文件号不符」，只有它和它的祖先留下，旁支照常删。
  - `pin::tests::remove_leaves_what_it_did_not_create`：原语层面，非空目录不删，被换的文件不删。
- **评审的另外两个反例**在新代码上都通过：第二轮反例二的改名现在被拒绝，dry-run 照常完成；报告的两个名字与临时文件名都是排他新建。
- **变异**：`output/w3-evidence/w3r3-mutation-evidence.json`。

## W3 整体评审第四轮（`output/peer-atm3-w3-r4.md`）

评审再次在写完报告之前被评审方的内容过滤中断，报告文件里留下了逐条确认的结论：P1-R3-01 的原反例在 fd92ce2 上通过（外来内容与祖先保留，返回 `CleanupIncomplete`）；另有一条 P1、一条 P2。

| 编号     | 问题                                                                                                                                                  | 修订                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| P1-R4-01 | 报告临时文件写完、关闭之后到改名之间，同名位置换进一个已有文件，并让目标报告名已存在：改名失败后 `write_new` 按路径删除临时文件，删掉的是换进来的那个 | 临时文件一直开着、不共享删除；改名与丢弃都按句柄（「目录身份」） |
| P2-R4-01 | 副本被别的程序开着（不共享删除）时清理正确地保留了它，但 `left` 只写了目录、没写文件名；短暂占用会被当成留下                                          | 错误文本带完整路径；共享冲突退避重试约 2 秒                      |

- **用例**：
  - `pin::tests::an_open_new_file_keeps_its_name_until_renamed_or_discarded`：开着的临时文件别人改不了名、删不掉；改名不替换已有名字；丢弃只删自己的临时文件。
  - `legacy.rs` 的 `w3_peer_r2::a_busy_copy_is_left_and_named`：一份副本一直被开着，结果是 `CleanupIncomplete`，`left` 只有一项、写的是那个文件。
  - `legacy.rs` 的 `w3_peer_r2::a_briefly_busy_copy_is_still_removed`：清理开始之后副本还被开着约 300 毫秒，照常删掉，结果是 Verified。
- **变异**：`output/w3-evidence/w3r4-mutation-evidence.json`。

## W3 整体评审第五轮（`output/peer-atm3-w3-r5.md`）：APPROVED

绑定 core-rust 02dd92c。无 P0、P1；P1-R4-01、P2-R4-01 关闭。新登记三条 P2，与 P2-01～P2-07 一起作为 W4 之前的硬门，修订如下（在 W4 关口的分支上）：

| 编号      | 问题 | 修订 |
| --------- | ---- | ---- |
| P2-R5-01  | 报告改名成功后刷盘失败、丢弃也失败时，错误里的路径仍是早已不存在的临时名；单独刷盘失败只有裸 IO 错误 | `NewFile::rename_into` 改名成功就记下新位置再刷盘，刷盘错误带「flush 路径」；丢弃的错误报文件实际所在的名字 |
| P2-R5-02  | 库旁边的 `-shm` 与别的程序的 `-SHM.tmp` 会让比较误报冲突、快照误判源未静止 | 见下文「库的索引不进快照」 |
| P2-R5-03  | 短暂占用用例的辅助线程等报告写完没有上限，dry-run 提前失败时会永久挂住 | 等待设 120 s 上限，超时照样放开文件、结束线程 |

- **用例**：
  - `pin::tests::a_failed_discard_names_where_the_file_is`：改名前双失败报临时名；改名后丢弃失败报新名、不含临时名。
  - `an_open_new_file_keeps_its_name_until_renamed_or_discarded` 加一条：改名之后 `path()` 是新名。
  - `w3_peer_r1::a_direct_conversion_ignores_the_wal_index_of_a_dropped_database`：直接按数据根转换（不经快照）时，舍弃项目目录里的 `-shm` 与 `-SHM.tmp` 不改变摘要。
- **变异**：`output/w3-evidence/p2gate-mutation-evidence.json`（含「the new name is not remembered」）。

## W4a：W3 遗留硬门（P2-01、P2-03、P2-04、P2-05）

W3 第一轮评审登记的 P2，要在 W4 使用转换输出、接线发布与回滚之前做完。

### P2-01：VERIFY 独立核对派生列

- **问题**：VERIFY 只按 2.x 的列比较。3.0 多出来的派生列——`project_paths.path_key` 与改写过的 `artifacts.local_path`——没有和源对过：前者只靠唯一约束兜底，后者只核对了 `legacy_local_path`。
- **修订**（`legacy.rs`）：
  - `r/project_paths.path_key`：由源的 `canonical_path` 用运行时查询的同一个函数（`paths::path_key`，注册成 SQL 函数 `atm_path_key`）重算，逐行核对。
  - `<pid>/artifacts.local_path`：由源行的 `local_path` 推出应有的值，逐行核对。映射在 SQL 里另写一遍，不复用转换时的函数——两边写错同一处才会漏过。
    - 按数据根转换时，指向本项目附件目录（原始根下）的改写成 `data/artifacts/<pid>/<相对路径>`，其余原样；
    - 不按数据根转换时一律原样。
  - 顺带修了转换时判断附件是否在目录下的 `relative_under`：原来按字符切前缀，两边含不同的多字节字符时会 panic，改为按字节比较（ASCII 不分大小写）。
- **用例**：
  - `verify_checks_the_derived_paths`：数据根转换后检查这两族都在。分别把目录里的附件改回原值、改成别的文件，把缺文件的附件改回原值，把目录外的附件改写，把 path_key 改成不折叠的。每一种都只有对应的那一族失败。
  - `legacy::root::tests::relative_under_compares_bytes_not_chars`。

### P2-03：进度按有界批次推进，首条在枚举之前

- **问题**：
  - 首条 SNAPSHOT 进度在完整枚举、散列 F0 之后才有。枚举超过 60 s，setup 在首条进度到达之前就超时。
  - IMPORT、VERIFY 只按项目报。一个大项目处理超过 10 min，就被判卡住。
- **修订**（`src/progress.rs`、`install-state` 的 `startup.rs`）：
  - 回调多一项「工作量」：单调递增，每做完一个有界的工作批次加一。
    - 读写文件：每 64 MiB 一次（散列、复制都经计量的读）；
    - 枚举：每个文件一次；
    - SQLite：每执行 100 万条虚拟机指令一次（`progress_handler`），装在目标库、源库的工作副本与探测副本上。迁移、IMPORT、VERIFY 都在 SQL 里做。
  - 工作量只随真实的工作增加，不是按时间刷新的心跳，卡住的转换照样会被判卡住。
  - `run` 一开始、任何枚举之前先报 SNAPSHOT 0/0。复制源库、补迁移算在 IMPORT 里，开始前先报 IMPORT 0/n。
  - 计量装在当前线程上（`progress::with`），深处的散列、复制、开库不必层层传参；作用域结束（含 panic）时恢复外层的。
  - setup 的 `ProgressWatch` 把 `(阶段, 已完成, 总数, 工作量)` 四项都算进「动没动」；`updated_at` 仍然不算。旧的进度文件没有 `work` 时按 0 读。
- **用例**：
  - `fault_matrix::the_first_progress_comes_before_enumeration`：根里有未登记的条目，枚举会拒绝；拒绝之前 setup 已经收到 SNAPSHOT 0/0，而且只有这一条。
  - `fault_matrix::a_large_project_keeps_the_work_moving`：一个项目有 30 万条进度。
    - IMPORT、VERIFY 里同一个「已完成/总数」下至少推进 5 批；
    - 假设每批都要 9 min，setup 一直在等；最后一批之后 10 min 判卡住。
  - `startup::tests::the_first_progress_has_until_the_first_budget_ends`：setup 每秒看一次，首条在第 59 s 到达就接着等；一直没有，第 60 s 判超时。
  - `startup::tests::work_alone_counts_as_movement`。
  - `progress::tests::*`：作用域与复原，SQL 与字节都推进工作量。
  - F15 改为第 1 s 就看第一次（原来是第 90 s，漏掉了真实轮询在 60 s 的判定），并断言第一条是 SNAPSHOT 0/0、工作量为 0。

### P2-04：store 与 setup 共用一份持久化契约

- **问题**：store 的改名是 `MoveFileExW(WRITE_THROUGH)`，setup 写回滚用的 `A` 却是 `fs::rename`。复制来的附件等没有逐个刷盘。改名的标志与退避重试没有确定性用例。
- **修订**：
  - 新增 `install-state/src/durable.rs`，store 与 setup 都只走它：
    - `rename`：`MoveFileExW(WRITE_THROUGH [| REPLACE_EXISTING])`，返回时改名已落盘；不替换时目标已存在就失败；共享冲突一类（5、32、33）退避重试约 10 秒，其余错误立即报错。
    - `write_atomic`：同目录临时文件、刷盘、替换地改名。
    - `sync_file`、`sync_tree`：逐个刷盘；被短暂占着同样退避重试；整树刷盘时，列出之后又消失的文件跳过（别的程序随建随删的临时文件）。
  - 改走它的地方：
    - store：转换的 `M`、`A`、报告、发布与封存的改名，备份的库与清单，恢复的目录交换；
    - install-state：进度文件与 setup 回滚写的 `A`；
    - setup：`fsx::write_atomic` 与全部移动（`move_path`、`replace_file`）。
  - 发布之前把发布物逐个文件刷盘，再写 `M = PUBLISHING`，再改名发布。范围与发布摘要相同：库与 `artifacts`、`sync`、`dispatch` 三个子树。库旁边会冒出别的程序的临时文件（实测 `ATM.SQLITE-SHM.tmp`，随建随删、还被占着），它们不属于发布物，不碰——第一次全套运行里三条用例就因为去刷它而失败。
  - `durable::record` 记下作用域内的每次改名与刷盘，用例据此核对调用方真的走了这里。
- **用例**：
  - `durable::tests::*`：
    - 标志：总带 WRITE_THROUGH，只有要替换时才带 REPLACE_EXISTING；
    - 共享冲突重试后成功（退避 10、20、40 ms）；
    - 一直被占，约 10 秒后报错，错误里有两个路径；
    - 其余错误不重试；
    - 不替换就不覆盖，整份替换不留临时文件，刷盘按文件逐个记录。
  - `startup::tests::rollback_writes_the_authority_only_after_publish`：`A` 是这次写入里唯一一次改名，标志是 REPLACE_EXISTING 加 WRITE_THROUGH。
  - `fault_matrix::publishing_flushes_every_file_then_moves_through_the_shared_contract`：
    - 发布物里每个文件都在发布改名之前刷过盘；
    - 发布改名不替换、带 WRITE_THROUGH；
    - 之后只有 `M` 与 `A` 两次替换地改名，`A` 在后。
  - `fsx::tests::writes_and_moves_go_through_the_shared_contract`（setup）。
  - 掉电实验仍放在 W8。

### P2-05：确定性的故障注入

- **注入点**：
  - `progress::stop_at(n, …)`：工作量到第 n 批时「进程被杀」。SQLite 中断正在执行的语句，读文件返回错误，`run` 不做任何收尾（不写 FAILED），返回 `Interrupted`。
  - `durable::inject(…)`：让作用域内被点名的写入、刷盘或改名以给定的错误失败，不重试。
- **用例**（`fault_matrix`）：
  - `a_copy_killed_halfway_restarts`：复制到一半被杀，staging 里只有一部分副本，再把一份截成半截。`M` 停在 SNAPSHOT。下次按 S3 重来，业务摘要与干净的一次相同，`L` 没动。
  - `an_import_killed_mid_transaction_restarts`：30 万条进度的项目正在 IMPORT 时被杀（SQLite 语句被中断）。`M` 停在 IMPORT。之后同上。
  - `a_full_disk_keeps_the_last_good_manifest`：从发布前的刷盘开始，每次写都失败（112），连 FAILED 也写不下。`M` 留着最后一份完整的（VERIFY），下次按 S3 安全重来。
  - `a_failed_publishing_rename_restarts`：发布改名本身失败。`M` 留在 PUBLISHING、不记 FAILED，发布物没到位，下次按 S3 重来。
  - `a_failure_after_the_publishing_rename_finishes_later`：发布物已改名到位，写 `M = PUBLISHED` 失败。下次按 S4 认发布物、补写 PUBLISHED 与 `A`。
- **用例带出的缺陷**：失败之后写 FAILED 也失败时（磁盘满），原来报的是写 FAILED 的错误，真正的原因丢了。现在报原来的原因，并注明 FAILED 没记下；`M` 留着上一份完整的。Verify 失败时报告写不下也不再掩盖原因。磁盘满用例断言报出的是刷盘失败。
- **限度**：「被杀」是注入的停下，连接仍按正常方式关闭（未提交的事务回滚）。真被杀时留下的是未提交的 WAL 帧，SQLite 下次打开时同样丢弃它们；staging 整个按 S3 丢弃，不读它。

### 变异

- `output/w4a-evidence/w4a-store-mutation-evidence.json`（14 条）；
- `w4a-state-mutation-evidence.json`（11 条）；
- `w4a-setup-mutation-evidence.json`（2 条）。

## W4 前的 P2 关口（P2-06、P2-07）

### P2-06：舍弃项目的摘要按内容取

- **问题**：`dropped/<id>` 原来对项目目录的每个文件取字节摘要。库开着 WAL 时，checkpoint、正常关库（WAL 合并、SHM 删掉）都会改变它，比较误报 Changed；A=legacy 时还会触发不必要的封存重转。
- **修订**（`legacy/settle.rs` 的 `tree_digest`）：
  - SQLite 库（文件头是 `SQLite format 3\0`）连同旁边的 `-wal`、`-shm` 算一项。库与非空的 `-wal` 复制到工作目录里打开（WAL 在副本里恢复，不开源文件），取逻辑内容：
    - `user_version`、`application_id`；
    - schema 的类型、名字、所属表、SQL（不含随存储变的 rootpage）；
    - 每张表与虚表的全部行，按全部列排序，不含隐含的 rowid（VACUUM 会给没有 INTEGER PRIMARY KEY 的表重排它）；
    - 不算 `sqlite_stat*`（ANALYZE、`PRAGMA optimize` 会写）与 FTS 的影子表（optimize、merge 会重排；虚表本身的行照算）。
  - 打不开或读不完的库绑定原始字节：库与非空的 `-wal`；`-shm` 只是 WAL 的索引，不算。这样的库任何变化（包括 checkpoint）都是「变了」：说不清就保守，不漏报。
  - 其他文件（附件、manifest、回滚件以外的普通文件）照旧按字节。
  - 工作目录里上一个库的副本删不掉就失败：残留的 `-wal` 会被当成下一个库的 WAL 恢复进去。
- **用例**（`legacy.rs` 的 `w3_peer_r1` 模块）：
  - `a_dropped_database_is_compared_by_content_not_storage`：转换时库开着 WAL、写入还只在 WAL 里。checkpoint、关库、SHM 重建、VACUUM、ANALYZE 与 `PRAGMA optimize`、改回 DELETE 日志，比较都是 Unchanged；只在 WAL 里的业务写入是 Changed，改回原值又是 Unchanged；加一个附件是 Changed。评审的反例（checkpoint 后关库）在其中。
  - `an_unreadable_dropped_database_is_bound_to_its_bytes`：打不开的库，加 `-shm` 不变；加非空 `-wal`、改一个字节都是 Changed。
  - 原有的 `a_drop_permission_is_bound_to_the_dropped_content`（业务修改、修好后拒绝舍弃许可）照旧通过。
- **变异**：`output/w3-evidence/w3gate-mutation-evidence.json`。

### P2-07：演练走正式链路

- **问题**：W3i 的演练脚本自己挑文件、`VACUUM INTO` 出逻辑副本，再以副本为 `L` 转换。评审的合成反例里，副本漏掉了知识库恢复依赖的回滚前库，附件路径也因为原路径不在副本里而没有映射；演练照样「通过」，退出码也是 0。
- **修订**：
  - 新增 `conversion::rehearse`：对 `L` 原样走正式的 dry-run、完整转换（`N` 在工作目录里）、启动判定与比较。不另做副本，所以复制集合（`snapshot_files`）、恢复依赖、路径映射都与正式转换相同。
  - 任何一步不是正式意义上的通过就停下：枚举拒绝（`Refused`）、dry-run 没有 VERIFY 通过或 `pending` 不空（`DryRun`）、完整转换失败（`Run`）、dry-run 与完整转换两次快照的 business_digest 不同（`Moved`）、启动判定不是 Published（`Decide`）、比较不是 Unchanged（`Compare`）。
  - 一致性边界：2.x 可以不停，静止判定按「静止」放行；副本的一致性由 SNAPSHOT 的 F0/F1 保证（复制前后两次枚举相同、副本的 sha256 逐个等于 F0）。两次快照之间、转换之后 `L` 变了，分别由 `Moved` 与 `Compare` 报出。
  - `examples/rehearse.rs` 改为调用它，每种停下各有非零退出码（3–8），去掉了自己的复制与 `--exclude`。
- **用例**（`legacy.rs` 的 `w3_gate_rehearse` 模块）：
  - `a_rehearsal_converts_the_root_as_it_is`：评审的反例。演练与正式转换得到同一个知识条目 slug（回滚前的库）与同一条附件路径。
  - `a_rehearsal_stops_at_the_first_failure`：未登记的条目在枚举时拒绝，一步都不做；两次快照之间改知识库是 `Moved`；转换之后改是 `Compare(Changed)`。
  - `a_rehearsal_stops_when_the_dry_run_does_not_verify`：2.0 救不回来、用户也没点名舍弃的项目，停在 dry-run，不做完整转换。
- **真实根重跑**（用户 2026-10-07 授权的 W3i 范围内，只读）：`output/w3i-real/run6/rehearse.log`，退出码 0。
  - 正式 SNAPSHOT 104 个文件；dry-run VERIFY 通过、没有 pending；dry-run 与完整转换都是 671 个业务族，摘要相同；PUBLISHED；启动判定 Published；与真实根比较 Unchanged。
  - 新库：24 个项目、2673 个任务、2682 个检查项、23582 条事件、170 条 legacy_backups。
  - 转换出的库用完即删，只留不含正文的报告与日志。
- **变异**：同上。

### 库的索引不进快照（P2-06 变异运行中发现）

- **现象**：
  - 关库前后，会有别的程序在库旁边随建随删 `<库名大写>-SHM.tmp`（实测 `ATM.SQLITE-SHM.tmp`、`PROJECT.SQLITE-SHM.tmp`），有时还占着。
  - 比较时 `L` 的项目目录里正好出现它，正式扫描把它当未登记条目拒绝，比较得 UNKNOWN。失败关闭、不丢数据，但会误报数据源冲突。
  - 另外，快照原来把 `-shm` 也算进 F0/F1：2.x 开着库时读者会改写 `-shm` 里的读标记（没有写入），关库时它又正被删除，都可能让快照误判源未静止，或者复制时找不到文件。
  - P2-06 的变异复原后整套里，`a_dropped_database_is_compared_by_content_not_storage` 在「关库」一步偶发得到 UNKNOWN，就是这个原因。
- **修订**：
  - `-shm` 与 `<库名>-shm.tmp`（不分大小写）都只是库的 WAL 索引：扫描认得它们（不再是未登记条目），快照不收，舍弃项目的摘要也不算。
  - 只认库自己的：别的名字（例如 `other.sqlite-shm.tmp`）照旧是未登记条目。
  - 工作副本本来就不复制 `-shm`（SQLite 打开时重建）。
- **用例**：
  - `w3_gate_snapshot::the_wal_index_is_not_part_of_the_snapshot`：
    - 放进 `-shm` 与两个 `*-SHM.tmp`，快照清单里都没有；
    - 别的名字的 `-shm.tmp` 照旧拒绝；
    - 复制之后、第二次枚举之前把它们删掉，dry-run 照样 VERIFY 通过。
  - `a_dropped_database_is_compared_by_content_not_storage` 加一步：舍弃项目的目录里出现 `PROJECT.SQLITE-SHM.tmp`，比较不变。
- **变异**：`output/w3-evidence/p2gate-mutation-evidence.json` 的「the WAL index is snapshotted」。

## W4 关口第一轮评审（`output/peer-atm3-w4a-r1.md`）：CHANGES_REQUESTED

绑定 e52d64c。无 P0。P2-01、P2-05、P2-R5-01 关闭；P2-07 方法成立。两条 P1、三条 P2 残留，修订在 w4a 92b24a1：

| 编号 | 问题 | 修订 |
| ---- | ---- | ---- |
| P1-W4A-01 | 快照按后缀排除 `-shm` / `-shm.tmp`，把同样结尾的附件也漏掉了：照样 PUBLISHED，`local_path` 指向不存在的文件，附件改了也比较不出来 | 只排除三个库旁边的 WAL 索引（`root::is_known_wal_index`：`registry/registry.sqlite`、`knowledge/knowledge.sqlite`、`projects/<pid>/project.sqlite`）；附件、日志即使同样结尾也进快照 |
| P1-W4A-02 | 舍弃项目里任何 SQLite 文件都按逻辑内容取摘要，不含 rowid：用户自己的 SQLite 附件改了 rowid（业务关联随之断开），比较仍判不变 | 只有项目目录下的 `project.sqlite`、并且有 `project_meta` 表，才按逻辑内容；其余 SQLite 文件（附件里的库与它们的 `-wal`、`-shm`）一律按字节；打得开但证明不了是项目库的也按字节 |
| P2-W4A-01 | 还有不报进度的耗时路径：数据根枚举、舍弃项目库的复制与逻辑扫描、VERIFY 与注册库的连接、发布前的 checkpoint、逐文件刷盘 | `root::walk` 每个条目推进一次；舍弃库的复制改走 `progress::copy_path`；上述连接都装 `progress::watch`；`publication_digest` 每个文件推进一次；刷盘改用 `durable::sync_tree_each`，每刷完一个文件推进一次 |
| P2-W4A-02 | backup 的撤回、放回与清理时的放回还是 `fs::rename`，绕过共用的持久化契约 | 新增 `durable::rename_once`（WRITE_THROUGH、经记录与注入，但遇占用不等、立即失败），三处都走它；撤回遇占用照旧立即 `KEPT(FILES_IN_USE)` |
| P2-W4A-03 | 短暂占用用例的辅助线程等不到报告时照样放开文件、返回，用例可能在前提没成立时变绿 | `hold_until` 返回有没有等到信号，用例断言它；另加一条不必等 120 s 的受控超时用例 |

- **用例**：
  - `w4_gate_r1::an_attachment_named_like_a_wal_index_is_still_an_attachment`：附件 `customer-shm.tmp`、`notes-SHM` 进快照、被复制，改了比较判变了；库旁边的 `project.sqlite-shm`、`REGISTRY.SQLITE-SHM.tmp` 照旧不进快照。
  - `w4_gate_r1::a_dropped_projects_sqlite_attachment_is_compared_by_bytes`：评审的正式链路反例。
  - `legacy::settle::tests::a_sqlite_attachment_is_bound_to_its_bytes`：附件库与「冒名」的项目库（没有 `project_meta`）按字节；真正的项目库 VACUUM、重排 rowid 不误报。
  - `legacy::settle::tests::the_logical_scan_reports_its_work`、`the_enumeration_reports_its_work`：30 万行的逻辑扫描、100 个文件的枚举都推进工作量。
  - `restore::withdrawal_moves_go_through_the_shared_contract`：撤回一次落盘移动后才删登记行；注入占用立即 `FILES_IN_USE`；DELETE 没删成（触发器）时落盘地放回；清理时的放回同样落盘。
  - `durable::once_tests::a_single_attempt_move_never_waits`：遇占用只试一次、不睡。
  - `w3_peer_r2::a_hold_that_never_sees_its_signal_says_so`。
- **setup 计时用例**：`health_is_bounded_by_one_deadline_not_per_read` 在负载下两次越过 1 s / 700 ms 的余量（评审如实记录）。改成拖延总时长 6 s 以上（20 段）、上限是期限加 1.5 s：「每次读各自计时」的错误做法仍远超上限，区分力不变。
- **变异**：`output/w4a-evidence/mutations-r2/`，绑定 92b24a1。两份新脚本验本轮修订；上一轮的四份脚本（锚点随修订更新）在新候选上重跑。结果见下节。
- **评审执行**：setup 的 `registry::tests::values_round_trip_and_restore_is_exact` 会写真实的 HKCU 测试键；委托允许的五包测试里要显式跳过它（第一轮评审意外触发过一次，环境拒绝）。

## 真实数据演练（W3i，用户 2026-10-07 授权）

- **方式**：`examples/rehearse.rs`。真实根正在被 2.x 使用，不停它，只读。
  - 复制业务目录做一致副本：库用只读连接 `VACUUM INTO`，其余文件逐字节复制；令牌、运行时文件、备份、日志一概不碰。
  - 先对真实根做一次正式转换的枚举与守卫（只读预检），再在副本上跑 dry-run，然后跑完整转换、启动判定与一次比较。
  - 副本与转换出的库用完即删，只留不含正文的 `report.json` 与日志（`output/w3i-real/`）。
- **发现一：族表漏登 `migration-manifest.json`**：
  - 这是 2.x 的数据根搬迁脚本（`scripts/migrate-data-root.ts`）在新根留下的记录，只有路径、项目数与时间。
  - 已归入 X5（setup），只计数；05 同步登记，用例 `a_data_root_converts_with_its_files` 断言它的计数。
- **发现二：一个项目目录里有游离的手工备份**：`projects\01KZH4YKQED25FZAZ3F9QKHMKY\project.sqlite.pre-ZB-T-0050-20260809-160053.bak`。
  - 看命名，是 Agent 在 ZB-T-0050 之前自己复制的，2.x 代码不写这种文件。
  - 规则不放宽：未登记就停（F23）。第一次演练按点名排除（`--exclude`）。
  - 用户决定不需要就删掉。核对后确认不需要：ZB-T-0050 已于 2026-08-09 完成，现库 42 MB 而它只有 2.5 MB，项目另有 2.x 的日、周备份。已移进回收站（可还原，由用户清空）。
  - 之后不带任何排除重跑：预检（正式转换对真实根的枚举与守卫）通过，要快照的 104 个文件与复制清单一致，结果同下（`output/w3i-real/run5/`）。
- **结论的范围**（W3 peer r2 P2-07）：本节的前五次演练是真实数据的逻辑副本演练。
  - 副本是演练脚本自己挑、自己复制的，库是 `VACUUM INTO` 出来的逻辑副本，不是原文件，也不在原路径上。
  - 所以它们不证明真实根本身（原文件、原路径、WAL 状态）的转换能走通。改走正式链路之后的第六次演练见「W4 前的 P2 关口」的 P2-07。
- **结果**（副本 26 个库、26 个文件，162 MB）：
  - dry-run：VERIFY 通过，671 个业务族，没有 pending。
  - 完整转换：PUBLISHED；启动判定 Published；与副本比较 Unchanged。
  - 新库：24 个项目、2636 个任务、2682 个检查项、23275 条事件。
- **报告里的差异，全部可解释**：
  - **规范化**：都是登记过的规则。N-01 共 758 行；N-05 的 lineage 跨 Agent 8 条、跨角色 6 条；N-04 1 条。
  - **信息项**：
    - 0015 派生列重算不一致，482 行。2.x 运行时会推进这些列，回填 SQL 只是初值；转换按原值保留，VERIFY 逐列核对。
    - SUPERSEDED 没有 ACTIVE 后继，10 条。这是 2.x 数据原样。
  - **回执**：AGENT 16579、BEGIN 496、USER 34、PROMOTION_HISTORY 3；没有违规。

## report.json

`Report::report_json()` 输出一个 JSON 对象，W3d 写到 `staging\<g>\report.json`；附件另见 `Report::attachment_jsonl()`。只含表名、主键、计数与摘要，不含正文与密钥（用例 `report_json_lists_every_family_without_bodies`）。

```text
{
  "format": "atm-conversion-report", "version": 1,
  "knowledge": "PRESENT" | "MISSING",
  "families": [
    { "code": "P3", "family": "<范围>/<族名>", "decision": "...", "drop_reason": str|null,
      "business_digest": bool, "pending": "needs the data root"|null,
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
