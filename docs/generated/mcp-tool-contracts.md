# MCP Tool Contracts

> Generated from `ToolDefinitionRegistry`; do not edit by hand.

Surface: `v4`

| Profile | Descriptor bytes | Profile schema hash |
| --- | ---: | --- |
| core | 7629 | `c533f5bca8e29e357e4f65f44e80fee2a9dd67968e026c3ded8b4cedd2cb30ba` |
| memory | 5267 | `af64a90c191c440313e697f266d7627db6780f9c117ec923ad2cb9ee8e4fd2f7` |
| actions | 5540 | `b99c31e93d3a819c114c5386ac83fd88017826e87bdd0e9c66ebdc2a9533f46a` |

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
| memory | `atm_feedback` | 提交仅存本机的 ATM 使用反馈。 | false | false | `b7785a7e8408` |
| memory | `atm_search` | 搜索事实。 | true | false | `2dab21182cf9` |
| memory | `atm_delta` | 读增量变化。 | true | false | `6441973a372b` |
| actions | `atm_task_patch` | 批量变更任务。 | false | true | `c95bd1e34656` |

## Legacy compatibility artifact

The unprofiled migration endpoint publishes the frozen v1.0.18 artifact from commit `410969b7fed5f1837078f6731271bf6c18381faf`: 11064 bytes, SHA-256 `8fab5e1eff857b3e7d0265d417c0da195194431e0cee37fdc95e4b1a3337a6d7`. Current installers only create the formal core, memory and actions profiles.
