# 错误信封与错误码

> 由 `atm_domain::error` 的错误码表与真实出错调用生成，不要手改。重新生成：`ATM_DOCS_BLESS=1 cargo test -p atm-http --test docs`。

<!-- ERROR_ENVELOPE:BEGIN -->

<!-- prettier-ignore-start -->

### 错误信封（自动生成）

工具调用出错时 `isError: true`，`structuredContent` 是下面的信封。照 `fix` 执行就是下一步，不需要读文档。

| 字段 | 出现 | 含义 |
| --- | --- | --- |
| `ok` | 总有 | 恒为 `false`。 |
| `code` | 总有 | 错误码，全表见 `docs/generated/error-codes.md`。 |
| `message` | 总有 | 给人看的说明。 |
| `retryable` | 总有 | 原样重试同一调用有没有可能成功（等待后）。 |
| `committed` | 总有 | 这次写入有没有落库：`false` 没有，`true` 已经落库（不要重试，按 fix 往下走），`"unknown"` 不确定（按 fix 原样重试，同一 `op_id` 会得到重放）。 |
| `fix` | 总有 | 下一步怎么做，`kind` 见下表。带 `call` 的可以原样执行：参数已经补齐并通过 schema。 |
| `problems` | 参数错误 | `INVALID_ARGUMENT` 的逐项问题：`path`、`problem`，以及按需的 `got`、`allowed`、`did_you_mean`。 |
| `state` | 按需 | 与错误有关的当前状态（例如任务现在的状态与版本），先读再决定时不必再查一次。 |
| `details` | 按需 | 其余结构化细节。 |

| `fix.kind` | 怎么做 |
| --- | --- |
| `call` | 执行 `fix.call`：改正后的同一调用，或者先做的那一步（例如 `start`）。 |
| `reread` | 先执行 `fix.call` 读一次当前状态，再决定下一步。 |
| `ask_user` | 把 `fix.message` 转告用户，由用户处理。 |
| `wait` | 等 `fix.retry_after_ms` 毫秒后重试；有 `fix.call` 时执行它。 |
| `add_param` | 补上 `fix.param` 再调 `fix.tool`（例如带上 `atm_begin` 返回的 session）。 |
| `none` | 内部错误，或者 Agent 碰不到的错误；不要重试，告诉用户。 |

下例是一次真实的出错调用：`operation` 写成了 `complet`。`fix.call` 是改正后的完整调用，可以原样执行。会话 id 换成了占位符。

```json
{
  "ok": false,
  "code": "INVALID_ARGUMENT",
  "message": "参数不合法：operation",
  "retryable": false,
  "committed": false,
  "fix": {
    "kind": "call",
    "call": {
      "name": "atm_task_patch",
      "arguments": {
        "project": "AYT-0001",
        "session": "<session>",
        "task_key": "AYT-0001-T-0001",
        "operation": "complete",
        "op_id": "op-typo"
      }
    },
    "why": "按 problems 更正后的同一调用（did_you_mean 已代入，不起作用的参数已去掉）"
  },
  "problems": [
    {
      "path": "operation",
      "problem": "enum",
      "got": "complet",
      "did_you_mean": "complete",
      "allowed": [
        "start",
        "complete",
        "verify",
        "verify_and_complete",
        "block",
        "wait_user",
        "wait_agent",
        "ready",
        "release",
        "claim",
        "cancel",
        "reopen",
        "edit",
        "checklist",
        "review_request",
        "review_submit"
      ]
    }
  ]
}
```

<!-- prettier-ignore-end -->

<!-- ERROR_ENVELOPE:END -->

## 错误码

每个错误码默认的 `fix.kind`；具体一次错误里的 `fix` 以信封为准（同一个码在不同场合可能给出更具体的出路）。

| code | HTTP | 可重试 | 默认 fix |
| --- | ---: | --- | --- |
| `KNOWLEDGE_UNAVAILABLE` | 503 | 是 | `wait` |
| `AGENT_RULE_MODIFIED_REQUIRES_REPAIR` | 409 |  | `ask_user` |
| `AGENT_RULE_NEEDS_EXPLICIT_UPDATE` | 409 |  | `ask_user` |
| `AGENT_SKILL_MODIFIED_REQUIRES_REPAIR` | 409 |  | `ask_user` |
| `ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT` | 422 |  | `call` |
| `BACKUP_FILE_MISSING` | 422 |  | `ask_user` |
| `BACKUP_HASH_MISMATCH` | 422 |  | `ask_user` |
| `BACKUP_INTEGRITY_FAILED` | 422 |  | `ask_user` |
| `BACKUP_MANIFEST_MISMATCH` | 422 |  | `ask_user` |
| `BACKUP_MANIFEST_MISSING` | 422 |  | `ask_user` |
| `BACKUP_NOT_FOUND` | 404 |  | `reread` |
| `BACKUP_PROJECT_IDENTITY_MISMATCH` | 422 |  | `ask_user` |
| `BACKUP_RESTORE_SCOPE_UNSUPPORTED` | 422 |  | `ask_user` |
| `BLOCKED_REASON_REQUIRED` | 422 |  | `call` |
| `CANDIDATE_HASH_MISMATCH` | 422 |  | `reread` |
| `CHECKLIST_NOT_FOUND` | 404 |  | `reread` |
| `CHECKLIST_TASK_MISMATCH` | 409 |  | `call` |
| `CLAIM_OWNER_REQUIRED` | 422 |  | `call` |
| `COMPLETION_GATE_FAILED` | 409 |  | `call` |
| `CONTINUATION_CONFLICT` | 409 |  | `reread` |
| `DEPENDENCY_CYCLE` | 409 |  | `call` |
| `DEPENDENCY_NOT_READY` | 409 |  | `call` |
| `DEPENDENCY_REF_NOT_FOUND` | 404 |  | `call` |
| `DISCOVERED_FROM_REF_NOT_FOUND` | 404 |  | `call` |
| `HIERARCHY_CYCLE` | 409 |  | `call` |
| `HIERARCHY_DEPTH` | 422 |  | `call` |
| `IDEMPOTENCY_CONFLICT` | 409 |  | `reread` |
| `IMMUTABLE_RECORD` | 409 |  | `call` |
| `IMPORT_OBJECTIVE_MISSING` | 422 |  | `call` |
| `IMPORT_SOURCE_CHANGED` | 409 |  | `reread` |
| `INVALID_ARGUMENT` | 400 |  | `call` |
| `INVALID_CURSOR` | 422 |  | `call` |
| `INVALID_PROJECT_CODE` | 422 |  | `call` |
| `INVALID_RESPONSE` | 502 | 是 | `wait` |
| `INVALID_TRANSITION` | 409 |  | `call` |
| `INVALID_WORK_ITEM_KEY` | 422 |  | `call` |
| `MILESTONE_OBJECTIVE_MISMATCH` | 409 |  | `call` |
| `MILESTONE_NOT_FOUND` | 404 |  | `call` |
| `NOT_FOUND` | 404 |  | `reread` |
| `OBJECTIVE_NOT_FOUND` | 404 |  | `call` |
| `OBJECTIVE_REQUIRED` | 422 |  | `call` |
| `OPERATION_ID_INVALID` | 422 |  | `call` |
| `OPERATION_NOT_FOUND` | 404 |  | `call` |
| `PARENT_REF_NOT_FOUND` | 404 |  | `call` |
| `PROGRESS_NOT_FOUND` | 404 |  | `reread` |
| `PROJECT_ALREADY_EXISTS` | 409 |  | `call` |
| `PROJECT_CODE_CONFLICT` | 409 |  | `call` |
| `PROJECT_CODE_EXHAUSTED` | 409 |  | `call` |
| `PROJECT_DB_QUICK_CHECK_FAILED` | 500 | 是 | `ask_user` |
| `PROJECT_DB_UNAVAILABLE` | 503 | 是 | `ask_user` |
| `PROJECT_LIFECYCLE_CONFLICT` | 409 |  | `reread` |
| `PROJECT_NOT_FOUND` | 404 |  | `call` |
| `PROJECT_PATH_CONFLICT` | 409 |  | `ask_user` |
| `PROJECT_REQUIRED` | 422 |  | `call` |
| `PROJECT_RESTORE_REQUEST_DECIDED` | 409 |  | `reread` |
| `PROJECT_RESTORE_REQUEST_NOT_FOUND` | 404 |  | `reread` |
| `PROJECT_UPDATE_DRAFT_NOT_FOUND` | 404 |  | `reread` |
| `PROJECT_UPDATE_NOT_FOUND` | 404 |  | `reread` |
| `RECORD_NOT_FOUND` | 404 |  | `call` |
| `RESULT_TOO_LARGE` | 422 |  | `call` |
| `REVIEWER_REQUIRED` | 403 |  | `call` |
| `REVIEWER_SESSION_REQUIRED` | 422 |  | `call` |
| `REVIEW_ALREADY_SUBMITTED` | 409 |  | `reread` |
| `REVIEW_BINDING_MISMATCH` | 409 |  | `reread` |
| `REVIEW_CHECKLIST_CLOSED` | 409 |  | `reread` |
| `REVIEW_IDENTITY_MISMATCH` | 409 |  | `call` |
| `REVIEW_REQUEST_CONFLICT` | 409 |  | `reread` |
| `REVIEW_REQUEST_NOT_FOUND` | 404 |  | `reread` |
| `REVIEW_REQUEST_REQUIRES_SESSION` | 422 |  | `call` |
| `REVIEW_TASK_CLOSED` | 409 |  | `reread` |
| `REVIEW_TASK_INVALID` | 422 |  | `call` |
| `SESSION_CLOSED` | 409 |  | `call` |
| `SESSION_NOT_FOUND` | 404 |  | `call` |
| `SESSION_NOT_RETIRED` | 409 |  | `call` |
| `SESSION_REQUIRED` | 422 |  | `add_param` |
| `SESSION_SUCCESSOR_AGENT_MISMATCH` | 409 |  | `call` |
| `SESSION_SUCCESSOR_AMBIGUOUS` | 409 |  | `call` |
| `SESSION_SUCCESSOR_IDENTITY_MISMATCH` | 409 |  | `call` |
| `TASK_ALREADY_CLAIMED` | 409 |  | `call` |
| `USER_AUTHORIZATION_REQUIRED` | 403 |  | `ask_user` |
| `VALIDATION_ERROR` | 422 |  | `call` |
| `VERSION_CONFLICT` | 409 | 是 | `call` |
| `WAITING_FOR_REQUIRED` | 422 |  | `call` |
| `WORK_ITEM_NOT_FOUND` | 404 |  | `call` |
| `CLAIM_NOT_OWNED` | 409 |  | `call` |
| `PLANNING_TARGET_CLOSED` | 409 |  | `call` |
| `REVIEW_SELF_NOT_ALLOWED` | 409 |  | `ask_user` |
| `WORK_ITEM_TERMINAL` | 409 |  | `call` |
| `STORE_BUSY` | 503 | 是 | `wait` |
| `SERVICE_UNAVAILABLE` | 503 | 是 | `wait` |
| `KNOWLEDGE_SLUG_CONFLICT` | 409 |  | `call` |
| `OPERATION_UNDONE_BY_RESTORE` | 409 |  | `reread` |
| `SCOPE_RESTORED` | 409 |  | `reread` |
| `TARGET_CHANGED` | 409 |  | `call` |
| `EXPECTED_VERSION_REQUIRED` | 422 |  | `call` |
| `RESULT_UNKNOWN` | 504 | 是 | `call` |

内部错误与 Agent 碰不到的码（`fix.kind` 为 `none`）：`AGENT_DOCS_MISSING`、`AGENT_GUIDE_MISSING`、`AGENT_SKILLS_MISSING`、`AGENT_SKILL_MISSING`、`COUNTER_NOT_FOUND`、`DUPLICATE_TOOL_DEFINITION`、`EXTERNAL_NAME_MISSING`、`FORBIDDEN`、`INTERNAL_ERROR`、`INVALID_TOOL_DESCRIPTION`、`METHOD_NOT_ALLOWED`、`MIGRATION_FILE_MISSING`、`MIGRATION_GAP`、`MIGRATION_HASH_MISMATCH`、`MIGRATION_HASH_ORIGIN`、`MIGRATION_HISTORY_GAP`、`MIGRATION_NAME_MISMATCH`、`MIGRATION_PLAN_EMPTY`、`PROJECT_META_MISSING`、`SAVED_VIEW_NAME_REQUIRED`、`SETTING_KEY_INVALID`、`SQLITE_FTS5_TRIGRAM_REQUIRED`、`SQLITE_VERSION_UNSAFE`、`UNAUTHORIZED`、`PRINCIPAL_CAPABILITY_DENIED`、`NOTIFICATION_MODE_INVALID`、`MCP_CLIENT_UNSUPPORTED`、`COMMAND_EXPIRED`。

