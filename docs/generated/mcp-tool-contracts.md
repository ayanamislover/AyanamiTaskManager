# MCP Tool Contracts

> Generated from `ToolDefinitionRegistry`; do not edit by hand.

Surface: `v3`

| Profile | Descriptor bytes | Profile schema hash |
| --- | ---: | --- |
| core | 7576 | `2e3f175dc5198e2d5609b67970c5ac08710c7eac16d66e70e3f6c3c7302da30d` |
| memory | 7625 | `1f8856d2cba2ef517a73e440e5b4cdcbde96556baf6bc72265baaf5c91b34b1c` |

| Profile | Tool | Description | Read only | Destructive | Schema hash |
| --- | --- | --- | --- | --- | --- |
| core | `atm_begin` | 直接使用返回的 brief | false | false | `82058715266c` |
| core | `atm_brief` | 仅在上下文压缩、长时间离开或明确恢复 working set | true | false | `9d1011547e2b` |
| core | `atm_task_list` | 分页列任务。 | true | false | `6092bbe6ff9a` |
| core | `atm_task_get` | 读单个任务。 | true | false | `39d377871891` |
| core | `atm_task_create` | 批量创建任务与关系。 | false | false | `548dec5e0352` |
| core | `atm_end` | 结束会话并交接。 | false | false | `ed553337d131` |
| memory | `atm_task_patch` | 批量变更任务。 | false | true | `b4d963fe1998` |
| memory | `atm_progress_add` | 写任务或项目进度。 | false | false | `a65dbceedb8a` |
| memory | `atm_record` | 保存关键记录。 | false | false | `dc6b90fa4655` |
| memory | `atm_search` | 搜索事实。 | true | false | `299484b05612` |
| memory | `atm_delta` | 读增量变化。 | true | false | `6441973a372b` |

## Legacy compatibility artifact

The unprofiled migration endpoint publishes the frozen v1.0.18 artifact from commit `410969b7fed5f1837078f6731271bf6c18381faf`: 11064 bytes, SHA-256 `8fab5e1eff857b3e7d0265d417c0da195194431e0cee37fdc95e4b1a3337a6d7`. Current installers only create the formal core and memory profiles.
