# Mutation Acknowledgement Contract

> Generated from `MUTATION_ACK_CONTRACT`; do not edit by hand.

<!-- MUTATION_ACK_CONTRACT:BEGIN -->

### 固定 mutation ACK

所有 mutation 工具只返回同一组有界字段；不要依赖操作特有的顶层字段。

| 字段                 | 语义                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ok`                 | 写操作是否被 ATM 接受。                                                                                                                                            |
| `op_id`              | 调用方提交的幂等操作 ID；重试必须复用。                                                                                                                            |
| `project`            | 规范化后的项目代码。                                                                                                                                               |
| `session`            | 实际承载写操作的 Session。                                                                                                                                         |
| `session_rebound`    | Session 过期并由 ATM 安全接续时为 `true`。                                                                                                                         |
| `projection`         | Registry 投影持久回执；含 `status`、`source_seq`、`projected_seq`、`retry_scheduled`、`last_error` 与累计 `retry_count`。`DEFERRED` 表示权威写已成功且后台会重试。 |
| `entities`           | 受影响实体的有界预览，每项含 `entity_type`、`key`、`version`。                                                                                                     |
| `entity_count`       | 完整受影响实体数量，不受预览截断影响。                                                                                                                             |
| `entities_truncated` | 实体预览是否被条数或字符预算截断。                                                                                                                                 |
| `details_cursor`     | 可直接作为 MCP 工具调用执行的有界 durable 实体回查描述符。                                                                                                         |

`entities` 最多预览 12 项且不超过 1800 个 JSON 字符。以 `entity_count` 判断精确总数；`entities_truncated=true` 时可直接执行返回的 `details_cursor` 做一次最多 50000 字符的 durable 回查：

```json
{
  "name": "atm_search",
  "arguments": {
    "project": "ATM",
    "op_id": "<same-op-id>",
    "session": "<returned-session>",
    "field_mask": ["op_id", "entities"],
    "max_chars": 50000
  }
}
```

需要操作特有结果时，仍以同一 `project`、`op_id` 和返回的 `session` 精确读取 durable operation receipt，只把 `field_mask` 改为下例；不要重新执行 mutation：

```json
{
  "name": "atm_search",
  "arguments": {
    "project": "ATM",
    "op_id": "<same-op-id>",
    "session": "<returned-session>",
    "field_mask": ["op_id", "mutations"],
    "max_chars": 50000
  }
}
```

例如自动补建规划根的事实位于 `operation.mutations[].response.planningRootProvisioned`；mutation ACK 顶层不再返回 `planning_root`。字段读取若返回 `done=false`，把 `next_cursor` 作为 `cursor` 加回同一个 `atm_search` 调用继续读，直到 `done=true`。

<!-- MUTATION_ACK_CONTRACT:END -->
