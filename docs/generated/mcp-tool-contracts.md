# MCP Tool Contracts

> Generated from `ToolDefinitionRegistry`; do not edit by hand.

Surface: `v5`

| Profile | Descriptor bytes | Profile schema hash |
| --- | ---: | --- |
| core | 7753 | `47781f8c8291202dc294025bd4715bf9b22a1ba7f8eedc035cfd4e004d2bc650` |
| memory | 6677 | `c4cb5ab5993705765ccae41b0c22b726602bc40dfa94bf4d75e07e38ea1e2151` |
| actions | 5962 | `c5e2406e60dc420b2ea2a381a9a6125c919c6f651a03057edf8507e1d34e34f4` |

| Profile | Tool | Description | Read only | Destructive | Schema hash |
| --- | --- | --- | --- | --- | --- |
| core | `atm_begin` | 开始或恢复会话并返回 brief。开工只调这一次，直接用返回的 brief。 | false | false | `fa11c96bc28c9e53` |
| core | `atm_brief` | 重新取回 working set。仅在上下文压缩、长时间离开或明确恢复时调用。 | true | false | `9d1011547e2bbe2f` |
| core | `atm_task_list` | 分页列任务。view=core\|context\|full\|reconcile。field_mask 语义同 atm_task_get。 | true | false | `35f36945bc60497d` |
| core | `atm_task_get` | 读单个任务。view=core\|context\|full。field_mask 在 view 已有的字段内过滤，越界字段会回显在 ignored_fields。 | true | false | `f5e0c7fc8446cb35` |
| core | `atm_task_create` | 批量创建任务与关系。 | false | false | `548dec5e03529ec8` |
| core | `atm_end` | 结束会话并交接。outcome=completed\|paused\|blocked\|cancelled\|error\|retired，全小写。summary 上限 500 个 code point。 | false | false | `ed553337d131e511` |
| memory | `atm_progress_add` | 写任务或项目进度。scope=task\|project；health=ON_TRACK\|AT_RISK\|OFF_TRACK\|UNKNOWN。summary 上限 500 个 code point。 | false | false | `a65dbceedb8a428b` |
| memory | `atm_record` | 保存关键记录。kind=DECISION\|CONSTRAINT\|FACT\|RISK\|REFERENCE\|LESSON；importance=LOW\|NORMAL\|HIGH\|CRITICAL。summary 上限 300 个 code point，长内容放 detail。 | false | false | `dc6b90fa4655b07b` |
| memory | `atm_feedback` | 提交仅存本机的 ATM 使用反馈。severity=LOW\|NORMAL\|HIGH\|CRITICAL。 | false | false | `b7785a7e840817cd` |
| memory | `atm_search` | 搜索事实。session 只能与 op_id 精确回查一起传。 | true | false | `2dab21182cf93660` |
| memory | `atm_delta` | 读增量变化。 | true | false | `6441973a372b0bbb` |
| memory | `atm_knowledge_search` | 搜索本地共享知识的摘要与适用范围。 | true | false | `8e25620829d4e8dc` |
| memory | `atm_knowledge_get` | 按 ID 读取固定修订的本地共享知识正文。 | true | false | `e8c34c68ad7a9db8` |
| actions | `atm_task_patch` | 批量变更任务。items 每条都要 task_key 与 expected_version，operation 取值：claim\|start\|release\|block\|wait_agent\|wait_user\|verify\|complete\|cancel\|reopen\|edit\|verify_and_complete\|review_request\|review_submit\|checklist_single\|checklist_batch。verify_and_complete\|review_request\|review_submit\|checklist_single\|checklist_batch 不可与其他操作同批，items 只允许一个元素。complete 还要求任务当前处于 IN_PROGRESS 或 VERIFYING，没开工过的先 start。 | false | true | `c95bd1e34656ee04` |

## Legacy compatibility artifact

The unprofiled migration endpoint publishes the frozen v1.0.18 artifact from commit `410969b7fed5f1837078f6731271bf6c18381faf`: 11064 bytes, SHA-256 `8fab5e1eff857b3e7d0265d417c0da195194431e0cee37fdc95e4b1a3337a6d7`. Current installers only create the formal core, memory and actions profiles.
