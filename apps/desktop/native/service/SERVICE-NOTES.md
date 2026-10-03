# atm-service 实现说明

只记规格（`output/atm3-spec/`）没有写死、由实现定下的取舍，以及与规格的对应关系。

## 写入流水线（`src/write.rs`，W2b）

落点固定的 operation 都走 `Service::write`，顺序定死：

1. `capability::require`（03 P-004）。被拒绝的调用不读库、不查回执、不入队：存储已关闭时，越权调用照样得到能力错误，读计数不变（用例 `a_refused_capability_writes_nothing_and_never_reaches_the_store`）。User 提交过的 op_id，Agent 拿来也换不到重放。
2. 不碰存储的入参判定：op_id 非空；只有 Agent 能带 session；需要 session 的能力缺 session 报 `SESSION_REQUIRED`，消息里直接告诉 Agent 先调 `atm_begin`。
3. 入队世代（R4）：调用方给了 `expected_generation` 就用它，否则经读连接取当前值。
4. 写事务内：命名空间与 lineage → R3′ 查找裁决 → 只有新写入过世代屏障 → 业务动作 → 写 canon-v2 回执。任何一步 `Err` 都整体回滚。

错误映射：`WriteError::Busy` → `STORE_BUSY`，`Closed` → `SERVICE_UNAVAILABLE`，超预算 / panic / SQLite → `INTERNAL_ERROR`（都已回滚）。

### 命名空间

| 主体              | 命名空间                                                  |
| ----------------- | --------------------------------------------------------- |
| Agent，带 session | `(SESSION, session_id)`，lineage 其他成员作为候选命名空间 |
| Agent，无 session | `(ACTOR, "AGENT:" + (actor 或 "AGENT_ANON"))`             |
| User              | `(ACTOR, "USER")`                                         |
| System            | `(ACTOR, "SYSTEM")`                                       |
| Phone             | `(ACTOR, "PHONE:" + device)`                              |

无 session 的 Agent 加 `AGENT:` 前缀是本实现定的：`actor` 是客户端自报的归属标签，不加前缀的话 Agent 报 `actor: "USER"` 就能落进 User 的命名空间、重放 User 的回执。R7‴ 转换来的 2.x 行只有 SESSION、`USER`、2.x 常量三种形状，没有无 session 的 Agent 行，所以加前缀不影响兼容。

### 旧格式键的探测

- 项目范围：转换器已经按 R7‴ 给可命中的行补了新键，不需要旧键探测。BEGIN 行只走调用索引。
- 知识库，Agent：lineage 每个 session 各一个 `agent:sha256([project, session, op_id])`，自己的那个算精确键。
- 知识库，User：op_id 原值。其他主体不探测原值键。

### 指纹重建的作者

`FpInput(family, author)` 由每个 operation 提供，返回业务字段（规范化后，不含定位字段与控制字段）。`None` 表示这个族表达不了这次请求（A3 的可比性检查），与该族的候选不匹配。canon-v2 必须总能表达。

| 候选的族     | 重建用的作者                                          |
| ------------ | ----------------------------------------------------- |
| canon-v2     | 候选的 `author_agent / author_session`                |
| kernel-v1    | 候选的 `actor_session_id`（2.x 0007 拆出的列）        |
| knowledge-v1 | 命中这条候选的那个 lineage 成员（旧键本身含 session） |

### 裁决的一个边角

R3′ 说「请求方自己的新键或 legacy 键精确命中，只看这一条」。如果自己的新键和自己的旧键恰好命中两条不同的行，实现把这两条当作多候选，按状态表裁决（不会挑其中一条忽略另一条）。

### 世代

世代读取复用 `atm_store::restore::current_generation`，与恢复写入的是同一个定义。范围在入队时不存在（`None`）就不设屏障，由业务动作报不存在；入队时存在、执行时世代不同，报 `SCOPE_RESTORED`，details 带 `expected_generation` 与 `current_generation`。

## 调用索引（`src/receipts.rs`）

`find_call` / `decide_call` 实现 A3 的 L/N 裁决表，`insert` 支持 CALL 行（四列原值，`ns_id = call_principal_id`）。begin、`project.create`、无目标 `quick.promote` 的目标判定（EXISTING / CREATE / NONE、`TARGET_CHANGED`）随这三个 operation 在后续阶段实现，届时直接调用这两个函数。

## 验收与变异

- `tests/write.rs`：零写入一律按整库逐表逐行快照比对。
- 变异验红：`output/w2-evidence/mutations/mut-w2b.py`，证据 `output/w2-evidence/w2b-mutation-evidence.json`。
