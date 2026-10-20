# 任务状态与操作

> 由 `atm_domain::work` 与 `atm-http` 的 task_patch 映射生成，不要手改。重新生成：`ATM_DOCS_BLESS=1 cargo test -p atm-http --test docs`。

<!-- WORK_ITEM_OPERATIONS:BEGIN -->

<!-- prettier-ignore-start -->

### 状态与操作（自动生成）

> 由 `atm_domain::work` 的状态机生成。这里只有状态机这一层；依赖、领取、完成门等前置条件另行判定，被拒时照错误里的 `fix` 执行。

| 状态 | 可用操作 → 之后的状态 |
| --- | --- |
| `BACKLOG` | `claim` → `CLAIMED`、`start` → `IN_PROGRESS`、`ready` → `READY`、`complete` → `DONE`、`cancel` → `CANCELLED`、`edit` → `BACKLOG` |
| `READY` | `claim` → `CLAIMED`、`start` → `IN_PROGRESS`、`ready` → `READY`、`complete` → `DONE`、`cancel` → `CANCELLED`、`edit` → `READY` |
| `CLAIMED` | `claim` → `CLAIMED`、`start` → `IN_PROGRESS`、`release` → `READY`、`block` → `BLOCKED`、`complete` → `DONE`、`cancel` → `CANCELLED`、`edit` → `CLAIMED` |
| `IN_PROGRESS` | `start` → `IN_PROGRESS`、`release` → `READY`、`block` → `BLOCKED`、`wait_agent` → `WAITING_AGENT`、`wait_user` → `WAITING_USER`、`verify` → `VERIFYING`、`complete` → `DONE`、`cancel` → `CANCELLED`、`edit` → `IN_PROGRESS` |
| `BLOCKED` | `start` → `IN_PROGRESS`、`release` → `READY`、`block` → `BLOCKED`、`wait_agent` → `WAITING_AGENT`、`wait_user` → `WAITING_USER`、`complete` → `DONE`、`cancel` → `CANCELLED`、`reopen` → `IN_PROGRESS`、`edit` → `BLOCKED` |
| `WAITING_AGENT` | `start` → `IN_PROGRESS`、`release` → `READY`、`block` → `BLOCKED`、`wait_agent` → `WAITING_AGENT`、`verify` → `VERIFYING`、`complete` → `DONE`、`cancel` → `CANCELLED`、`reopen` → `IN_PROGRESS`、`edit` → `WAITING_AGENT` |
| `WAITING_USER` | `start` → `IN_PROGRESS`、`release` → `READY`、`block` → `BLOCKED`、`wait_user` → `WAITING_USER`、`verify` → `VERIFYING`、`complete` → `DONE`、`cancel` → `CANCELLED`、`reopen` → `IN_PROGRESS`、`edit` → `WAITING_USER` |
| `VERIFYING` | `start` → `IN_PROGRESS`、`release` → `READY`、`block` → `BLOCKED`、`wait_agent` → `WAITING_AGENT`、`wait_user` → `WAITING_USER`、`verify` → `VERIFYING`、`complete` → `DONE`、`cancel` → `CANCELLED`、`reopen` → `IN_PROGRESS`、`edit` → `VERIFYING` |
| `DONE` | `reopen` → `IN_PROGRESS`、`edit` → `DONE` |
| `CANCELLED` | `reopen` → `BACKLOG`、`edit` → `CANCELLED` |

`IN_PROGRESS` 上的 `claim` 只在同一条会话链的后继会话接回领取时成立，上表没有列出。

| 操作 | 可以从这些状态发起 | 任务被别人领取时拒绝 |
| --- | --- | --- |
| `claim` | `BACKLOG`、`READY`、`CLAIMED`、`IN_PROGRESS` | 否 |
| `start` | `BACKLOG`、`READY`、`CLAIMED`、`IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING` | 否 |
| `release` | `CLAIMED`、`IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING` | 否 |
| `ready` | `BACKLOG`、`READY` | 是 |
| `block` | `CLAIMED`、`IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING` | 是 |
| `wait_agent` | `IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`VERIFYING` | 是 |
| `wait_user` | `IN_PROGRESS`、`BLOCKED`、`WAITING_USER`、`VERIFYING` | 是 |
| `verify` | `IN_PROGRESS`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING` | 是 |
| `complete` | `BACKLOG`、`READY`、`CLAIMED`、`IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING` | 是 |
| `cancel` | `BACKLOG`、`READY`、`CLAIMED`、`IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING` | 是 |
| `reopen` | `BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING`、`DONE`、`CANCELLED` | 是 |
| `edit` | `BACKLOG`、`READY`、`CLAIMED`、`IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING`、`DONE`、`CANCELLED` | 是 |

`claim`、`start`、`release` 本身就是领取规则：能不能接手由领取是否过期、是否同一条会话链决定。

#### 自动补 start

下列写入遇到还没开工的任务时，在同一事务里先 `start` 再执行（调用方能领取时）；遇到 `BLOCKED` / `WAITING_*` 不补（`start` 会解除阻塞），被拒时 `fix` 就是那条 `start`。

| 写入 | `BACKLOG` | `READY` | `CLAIMED` | `IN_PROGRESS` | `BLOCKED` | `WAITING_AGENT` | `WAITING_USER` | `VERIFYING` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `block` | 先 start | 先 start | 先 start | — | — | — | — | — |
| `wait_agent` | 先 start | 先 start | 先 start | — | — | — | 拒绝，fix 给 start | — |
| `wait_user` | 先 start | 先 start | 先 start | — | — | 拒绝，fix 给 start | — | — |
| `verify` | 先 start | 先 start | 先 start | — | 拒绝，fix 给 start | — | — | — |
| `complete` | 先 start | 先 start | 先 start | — | 拒绝，fix 给 start | 拒绝，fix 给 start | 拒绝，fix 给 start | — |
| `verify_and_complete` | 先 start | 先 start | 先 start | — | 拒绝，fix 给 start | — | — | — |
| `atm_progress_add（任务进度）` | 先 start | 先 start | 先 start | — | — | — | — | — |

「—」：不涉及自动 start，按上面的状态表处理。

任务进度的 start 是尽力而为：前置没完成或领不到时不补、不报错，进度照记，任务保持原状态；带 `blocker` 时补上 start 再阻塞，补不上就按原状态判定（`READY` 上不能阻塞）。

#### 什么时候要带 `expected_version`

| 写入 | 本会话链持有领取 | 没有持有（别人的任务、未领取） |
| --- | --- | --- |
| `claim` | 可省略 | 必填 |
| `start` | 可省略 | 必填 |
| `release` | 可省略 | 必填 |
| `ready` | 可省略 | 必填 |
| `block` | 可省略 | 必填 |
| `wait_agent` | 可省略 | 必填 |
| `wait_user` | 可省略 | 必填 |
| `verify` | 可省略 | 必填 |
| `complete` | 可省略 | 必填 |
| `cancel` | 必填 | 必填 |
| `reopen` | 必填 | 必填 |
| `edit` | 必填 | 必填 |
| `verify_and_complete` | 可省略 | 必填 |
| `checklist`（1 条） | 可省略 | 必填 |
| `checklist`（多条） | 可省略 | 必填 |
| `review_request` | 必填 | 必填 |
| `review_submit` | 必填 | 必填 |

「持有领取」以执行那一刻为准，包括这次 `claim` / `start` / 自动 start 刚拿到的领取。版本号用上一次回执里的 `entities[].version`，不要自己加一。

<!-- prettier-ignore-end -->

<!-- WORK_ITEM_OPERATIONS:END -->

<!-- TASK_PATCH_COMPOSITE:BEGIN -->

<!-- prettier-ignore-start -->

### task_patch 的操作与字段（自动生成）

> 由 `atm-http` 的 task_patch 映射生成（`write::COMMON`、`write::operation_fields`、`write::COMPOSITE`）。

单条直接把字段写在顶层：`{task_key, operation, …}`；多条放进 `items`，每条同形，两种写法不能混用。每条都能写的字段：`task_key`、`operation`、`expected_version`、`takeover_stale`。

| operation | 额外字段（粗体必填） | 只能单条 |
| --- | --- | --- |
| `start` | — |  |
| `complete` | `note`、`evidence`、`checklist` |  |
| `verify` | — |  |
| `verify_and_complete` | — | 是 |
| `block` | **`blocked_reason`** |  |
| `wait_user` | **`waiting_for`** |  |
| `wait_agent` | **`waiting_for`** |  |
| `ready` | — |  |
| `release` | — |  |
| `claim` | — |  |
| `cancel` | `cancel_reason`、`duplicate_of`、`superseded_by` |  |
| `reopen` | — |  |
| `edit` | `title`、`description`、`acceptance`、`target_date`、`parent_key`、`assignee_agent_id`、`depends_on`、`discovered_from`、`expected_fields` |  |
| `checklist` | `checklist`、`evidence` | 是 |
| `review_request` | **`parent_checklist_id`**、**`expected_parent_checklist_version`**、**`candidate_hashes`** | 是 |
| `review_submit` | **`request_key`**、**`verdict`**、**`candidate_hashes`**、**`evidence`** | 是 |

只能单条的操作不放进多条的 `items`，也不收 `takeover_stale`。旧名 `checklist_single`、`checklist_batch` 照收，等同于 `checklist`（按条数分派）。

<!-- prettier-ignore-end -->

<!-- TASK_PATCH_COMPOSITE:END -->
