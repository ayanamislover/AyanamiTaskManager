# 写入回执

> 由 `atm-http` 的写入回执（对照真实调用）生成，不要手改。重新生成：`ATM_DOCS_BLESS=1 cargo test -p atm-http --test docs`。

<!-- MUTATION_ACK_CONTRACT:BEGIN -->

<!-- prettier-ignore-start -->

### 写入回执（自动生成）

`atm_task_create`、`atm_task_patch`、`atm_progress_add`、`atm_record`、`atm_end` 等项目写入都返回同一形状的回执；`atm_knowledge_save` 写的是共享知识库，回执另有形状，不适用本节。

| 字段 | 出现 | 含义 |
| --- | --- | --- |
| `ok` | 总有 | 恒为 `true`。写入失败时返回的是错误信封（见下一节），不是 `ok:false` 的回执。 |
| `op_id` | 总有 | 这次写入的幂等键。省略时由 ATM 生成；同一写入要自己重试时，带上这个值，结果是重放而不是再执行一次。 |
| `project` | 总有 | 规范化后的项目代码。 |
| `session` | 总有 | 回执所属的会话：会话被接续时是后继会话，重放时是当初写下回执的那个会话。 |
| `session_rebound` | 总有 | 原会话已经失效、ATM 把这次写入接到了同一条会话链的后继会话上时为 `true`。 |
| `replayed` | 总有 | 同一 `op_id` 的重放：这次没有再执行，返回的是当初的结果。 |
| `entities` | 总有 | 受影响实体的有界预览。每项有 `entity_type`、`key`、`version`；任务还有 `status`、`waiting_on`、`claimed_by_session_id`、`claim_lease_until`。版本是这次写入之后的版本，下一次写同一实体直接用它，不要自己加一。 |
| `entity_count` | 总有 | 受影响实体的总数，不受预览截断影响。 |
| `entities_truncated` | 总有 | 预览被截断时为 `true`；这时原样执行 `details_cursor` 取全部实体。 |
| `details_cursor` | 总有 | 可以原样执行的 `atm_search` 调用，回查这次写入的全部实体。 |
| `normalized` | 按需 | 参数里用了别名或非规范写法时出现：`[{from, to}]`，说明改成了哪个规范名。下次直接用规范名。 |
| `auto_applied` | 按需 | 自动补了 `start` 时出现：`[{task_key, operations}]`。 |
| `refs` | 按需 | `atm_task_create`：本批序号（`"1"` 起）与 `client_ref` 到任务 key 的对照。 |
| `checklist` | 按需 | `atm_task_create`：每个新任务的检查项 id，按任务 key 分组。 |
| `adjusted` | 按需 | 服务端调整了参数时出现，例如 summary 太长被截断、全文移到 detail：`[{field, action, moved_to}]`。 |
| `deprecations` | 按需 | 用了仍然照收的旧写法时出现，说明该换成什么。 |
| `merges` | 按需 | `edit` 带 `expected_fields` 时，与并发修改安全合并的字段。 |

下例是一次真实的 `atm_task_patch` 回执：用了别名 `key`，任务还没开工所以先自动 `start` 再 `verify`。会话 id 与租约时间换成了占位符。

```json
{
  "ok": true,
  "op_id": "op-example",
  "project": "AYT-0001",
  "session": "<session>",
  "session_rebound": false,
  "replayed": false,
  "entities": [
    {
      "entity_type": "WORK_ITEM",
      "key": "AYT-0001-T-0001",
      "version": 3,
      "status": "VERIFYING",
      "waiting_on": null,
      "claimed_by_session_id": "<session>",
      "claim_lease_until": "<lease>"
    }
  ],
  "entity_count": 1,
  "entities_truncated": false,
  "details_cursor": {
    "name": "atm_search",
    "arguments": {
      "project": "AYT-0001",
      "op_id": "op-example",
      "session": "<session>",
      "field_mask": [
        "op_id",
        "entities"
      ],
      "max_chars": 50000
    }
  },
  "auto_applied": [
    {
      "task_key": "AYT-0001-T-0001",
      "operations": [
        "start"
      ]
    }
  ],
  "normalized": [
    {
      "from": "key",
      "to": "task_key"
    }
  ]
}
```

<!-- prettier-ignore-end -->

<!-- MUTATION_ACK_CONTRACT:END -->
