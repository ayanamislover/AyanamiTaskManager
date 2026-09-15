# MCP Tool Contracts

> Generated from `ToolDefinitionRegistry`; do not edit by hand.

Surface: `v5`

| Profile | Descriptor bytes | Profile schema hash |
| --- | ---: | --- |
| core | 7629 | `6b500172d3de47bccbae592cf80d282fd87385d9f15133009a2e56dae254841e` |
| memory | 6833 | `6205f3cd00d5668632edc0545b8c927f14a73443db137540647a59e4b940793e` |
| actions | 5540 | `c88d683554c3552f4a3d147b20a67f707306624dd2427f3062d78aa963c07c4c` |

| Profile | Tool | Description | Read only | Destructive | Schema hash |
| --- | --- | --- | --- | --- | --- |
| core | `atm_begin` | 直接使用返回的 brief | false | false | `fa11c96bc28c` |
| core | `atm_brief` | 仅在上下文压缩、长时间离开或明确恢复 working set | true | false | `9d1011547e2b` |
| core | `atm_task_list` | 分页列任务。 | true | false | `6092bbe6ff9a` |
| core | `atm_task_get` | 读单个任务。 | true | false | `39d377871891` |
| core | `atm_task_create` | 批量创建任务与关系。 | false | false | `548dec5e0352` |
| core | `atm_end` | 结束会话并交接。 | false | false | `ed553337d131` |
| memory | `atm_progress_add` | 写任务或项目进度。scope=task|project；health=ON_TRACK|AT_RISK|OFF_TRACK|UNKNOWN。 | false | false | `a65dbceedb8a` |
| memory | `atm_record` | 保存关键记录。kind=DECISION|CONSTRAINT|FACT|RISK|REFERENCE|LESSON。 | false | false | `dc6b90fa4655` |
| memory | `atm_feedback` | 提交仅存本机的 ATM 使用反馈。severity=LOW|NORMAL|HIGH|CRITICAL。 | false | false | `b7785a7e8408` |
| memory | `atm_search` | 搜索事实。 | true | false | `2dab21182cf9` |
| memory | `atm_delta` | 读增量变化。 | true | false | `6441973a372b` |
| memory | `atm_knowledge_search` | 搜索本地共享知识的摘要与适用范围。 | true | false | `8e25620829d4` |
| memory | `atm_knowledge_get` | 按 ID 读取固定修订的本地共享知识正文。 | true | false | `e8c34c68ad7a` |
| actions | `atm_task_patch` | 批量变更任务。 | false | true | `c95bd1e34656` |

## Legacy compatibility artifact

The unprofiled migration endpoint publishes the frozen v1.0.18 artifact from commit `410969b7fed5f1837078f6731271bf6c18381faf`: 11064 bytes, SHA-256 `8fab5e1eff857b3e7d0265d417c0da195194431e0cee37fdc95e4b1a3337a6d7`. Current installers only create the formal core, memory and actions profiles.
