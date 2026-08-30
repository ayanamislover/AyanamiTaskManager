# WorkItem Operation Contracts

> Generated from `WorkItemOperations` and `TaskPatchOperations`; do not edit by hand.

<!-- WORK_ITEM_OPERATIONS:BEGIN -->

### 状态与操作（自动生成）

> 本表由 canonical `WorkItemOperations` registry 生成；不要手工维护状态机副本。

<!-- prettier-ignore -->
| 状态 | 显示名 | 合法操作 |
| --- | --- | --- |
| `BACKLOG` | 待整理 | `claim`, `start`, `complete`, `cancel`, `edit` |
| `READY` | 可开始 | `claim`, `start`, `complete`, `cancel`, `edit` |
| `CLAIMED` | 已领取 | `claim`, `start`, `release`, `block`, `complete`, `cancel`, `edit` |
| `IN_PROGRESS` | 进行中 | `start`, `release`, `block`, `wait_agent`, `wait_user`, `verify`, `complete`, `cancel`, `edit` |
| `BLOCKED` | 已阻塞 | `start`, `release`, `block`, `complete`, `cancel`, `reopen`, `edit` |
| `WAITING_USER` | 等待用户 | `start`, `release`, `block`, `wait_user`, `verify`, `complete`, `cancel`, `reopen`, `edit` |
| `WAITING_AGENT` | 等待 Agent | `start`, `release`, `block`, `wait_agent`, `verify`, `complete`, `cancel`, `reopen`, `edit` |
| `VERIFYING` | 验收中 | `start`, `release`, `block`, `wait_agent`, `wait_user`, `verify`, `complete`, `cancel`, `reopen`, `edit` |
| `DONE` | 已完成 | `reopen`, `edit` |
| `CANCELLED` | 已取消 | `reopen`, `edit` |

<!-- prettier-ignore -->
| 操作 | 显示名 | 可进入的当前状态 | 前置条件 |
| --- | --- | --- | --- |
| `claim` | 领取 | `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS` | DEPENDENCIES_READY, CLAIM_AVAILABLE, SAME_ASSIGNEE_WHEN_RUNNING |
| `start` | 开始 | `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | DEPENDENCIES_READY, CLAIM_AVAILABLE |
| `release` | 释放过期领取 | `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | CLAIM_OWNER |
| `block` | 阻塞 | `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | BLOCKED_REASON |
| `wait_agent` | 等待 Agent | `IN_PROGRESS`, `VERIFYING`, `WAITING_AGENT` | WAITING_FOR |
| `wait_user` | 等待用户 | `IN_PROGRESS`, `VERIFYING`, `WAITING_USER` | WAITING_FOR |
| `verify` | 提交验收 | `IN_PROGRESS`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | - |
| `complete` | 完成 | `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | COMPLETION_GATE |
| `cancel` | 取消 | `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | CANCEL_REFERENCES |
| `reopen` | 重新打开 | `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING`, `DONE`, `CANCELLED` | - |
| `edit` | 编辑 | `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING`, `DONE`, `CANCELLED` | - |

<!-- WORK_ITEM_OPERATIONS:END -->

<!-- TASK_PATCH_COMPOSITE:BEGIN -->

### composite 任务操作（自动生成）

上一张表只列状态机操作。`atm_task_patch` 还接受下列 composite 操作，它们**不可与其他操作同批**：
`items` 只允许一个元素。

所有条目共用 `task_key` + `expected_version` 骨架。**`expected_version` 的语义按操作而异**：
`checklist_single` 比的是那条检查项自己的版本，其余操作都比任务版本。字段名相同不代表语义相同。

#### `verify_and_complete`

一次调用完成 verify 与 complete，省掉中间那次版本读取。

```json
{
  "operation": "verify_and_complete",
  "task_key": "ATM-T-0001",
  "expected_version": 7
}
```

#### `checklist_single`

改一条检查项。`checklist_items` 必须恰好一个元素，不是把 id 放到条目顶层。**`expected_version` 是检查项自己的版本，不是任务版本**（`atm_task_get(view="full")` 的 `checklist[].version`）。`task_key` 会校验归属，检查项不属于它就报 `CHECKLIST_TASK_MISMATCH`。

```json
{
  "operation": "checklist_single",
  "task_key": "ATM-T-0001",
  "expected_version": 0,
  "checklist_items": [
    {
      "id": "01M0W8440REDVKEFXQ9TW54HQX",
      "status": "DONE",
      "evidence": [
        {
          "kind": "test_result",
          "value": "186 passed",
          "note": "聚焦回归"
        }
      ]
    }
  ]
}
```

#### `checklist_batch`

整批改检查项，任一条失败则整批回滚。`expected_version` 是**任务**的版本，并会校验每条检查项确实属于该任务，否则报 `TASK_MISMATCH`。

```json
{
  "operation": "checklist_batch",
  "task_key": "ATM-T-0001",
  "expected_version": 7,
  "checklist_items": [
    {
      "id": "01M0W8440REDVKEFXQ9TW54HQX",
      "status": "DONE",
      "evidence": ["docs/report.md"]
    },
    {
      "id": "01M0W8440REDVKEFXQ9TW54HQY",
      "status": "SKIPPED"
    }
  ]
}
```

#### `review_request`

对 REVIEW 任务发起复核请求，并钉住候选哈希。

```json
{
  "operation": "review_request",
  "task_key": "ATM-T-0002",
  "expected_version": 3,
  "parent_checklist_id": "01M0W8440REDVKEFXQ9TW54HQX",
  "expected_parent_checklist_version": 0,
  "candidate_hashes": {
    "source": "695feabb8d32f02c"
  }
}
```

#### `review_submit`

提交复核结论；`evidence` 至少一条。

```json
{
  "operation": "review_submit",
  "task_key": "ATM-T-0002",
  "expected_version": 4,
  "request_key": "ATM-RR-0001",
  "verdict": "APPROVED",
  "candidate_hashes": {
    "source": "695feabb8d32f02c"
  },
  "evidence": [
    {
      "kind": "git_sha",
      "value": "695feabb8d32f02c",
      "note": "复核基线"
    }
  ]
}
```

<!-- TASK_PATCH_COMPOSITE:END -->
