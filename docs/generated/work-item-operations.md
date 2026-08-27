# WorkItem Operation Contracts

> Generated from `WorkItemOperations`; do not edit by hand.

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
