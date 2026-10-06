# 转换报告与对象族清单（05 §3.4、§5.2；W3b1）

转换器（`store/src/legacy.rs`）的报告按一张固定的对象族表组织。族表在 `store/src/legacy/families.rs`，用例 `the_family_table_matches_05_and_claims_every_2x_table` 按 05 逐行手抄期望值比对。

## 族表

- **编号**沿用 05 §5.2：R1–R12（registry）、K1–K5（knowledge）、P1–P11（每个项目）、F1–F7（数据根文件）。§5.2「显式排除」表的各行编为 X1–X12，顺序与表格相同。同一编号可以有多个族，例如 P3 是十四张表。
- **每张 2.x 表恰好归一个族**。FTS 的影子表（`_config/_content/_data/_docsize/_idx`）随主表归族。转换入口的登记完整性检查（`check_source`）也用这张表，所以族表里少登记一张表，转换就拒绝这个源（`UnknownTable`）。
- **decision**：`CONVERTED`（逐行或逐文件进新库）、`REBUILT`（派生数据，在新库重建，查询等价）、`DROPPED`（不进新库，`drop_reason` 写理由）、`REFERENCED`（不复制，只登记引用）。
- **business_digest**：是否纳入回滚检测（05 §5.2「纳入」列）。X 类和 F7 不纳入。
- **pending**：还没实现的族及负责的任务。DB 族都已实现；非 DB 文件族归 W3b4（附件、manifest、R / X 类路径）、W3b5（sync / dispatch）、W3b6（进行中的文件事务）。`Report::pending()` 列出这些族实例，**W3d 的提交门要求它为空**。

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
  "rule_mismatches": [str], "coverage_gaps": [str],
  "receipts": { "classes": {…}, "promotion_shaped_agent": n, "promotion_status": {…}, "violations": [str] },
  "global_feed": { "orphans": n, "mirrors_replayed": n },
  "outbox_without_event": n, "unresolved_promotions": n, "artifact_rows": n
}
```

- 族实例：registry 与数据根各一份，有知识库时一份，每个项目一份（P1–P11 与项目的 X1）。
- `target.rows`、`target.digest` 取检查名与族实例名相同的那项检查（主检查），没有就是 `null`。
- 规则标识与原因的拆分见 `NORMALIZATION.md`「报告」。
