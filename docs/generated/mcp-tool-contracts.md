# MCP Tool Contracts

> Generated from `ToolDefinitionRegistry`; do not edit by hand.

Surface: `v3`

| Profile | Descriptor bytes | Profile schema hash |
| --- | ---: | --- |
| core | 7629 | `6976add811c21234f48650494005a6dab2c640dd95f591c1a0104b5282508ea4` |
| memory | 4409 | `9b51e2fc76507f6ee610de4c1e5b4acb9bcaef38ca4144adf0d5cdb4cc21bd86` |
| actions | 5540 | `3118447dc17eb8f2e5b1e0b7e3beaa9d87f7d8da37c2e324b25275fcbad6e47c` |

| Profile | Tool | Description | Read only | Destructive | Schema hash |
| --- | --- | --- | --- | --- | --- |
| core | `atm_begin` | 直接使用返回的 brief | false | false | `fa11c96bc28c` |
| core | `atm_brief` | 仅在上下文压缩、长时间离开或明确恢复 working set | true | false | `9d1011547e2b` |
| core | `atm_task_list` | 分页列任务。 | true | false | `6092bbe6ff9a` |
| core | `atm_task_get` | 读单个任务。 | true | false | `39d377871891` |
| core | `atm_task_create` | 批量创建任务与关系。 | false | false | `548dec5e0352` |
| core | `atm_end` | 结束会话并交接。 | false | false | `ed553337d131` |
| memory | `atm_progress_add` | 写任务或项目进度。 | false | false | `a65dbceedb8a` |
| memory | `atm_record` | 保存关键记录。 | false | false | `dc6b90fa4655` |
| memory | `atm_search` | 搜索事实。 | true | false | `2dab21182cf9` |
| memory | `atm_delta` | 读增量变化。 | true | false | `6441973a372b` |
| actions | `atm_task_patch` | 批量变更任务。 | false | true | `c95bd1e34656` |

## Legacy compatibility artifact

The unprofiled migration endpoint publishes the frozen v1.0.18 artifact from commit `410969b7fed5f1837078f6731271bf6c18381faf`: 11064 bytes, SHA-256 `8fab5e1eff857b3e7d0265d417c0da195194431e0cee37fdc95e4b1a3337a6d7`. Current installers only create the formal core, memory and actions profiles.
