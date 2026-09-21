# MCP Tool Contracts

> Generated from `ToolDefinitionRegistry`; do not edit by hand.

Surface: `v5`

| Profile | Descriptor bytes | Profile schema hash |
| --- | ---: | --- |
| core | 7913 | `d2cef6a6c9b4a6346371f12e24d644b08b10c28be603ce413f6d1f8133831645` |
| memory | 9087 | `f9a27099670d5dc6506d08e5e2be8da6f6255bc5641f5b118166549490ed526c` |
| actions | 7975 | `2e20175aabf65c942d374929db2758018cc804155bba4b72069064b444aed2b9` |

| Profile | Tool | Description | Read only | Destructive | Schema hash |
| --- | --- | --- | --- | --- | --- |
| core | `atm_begin` | 开始或恢复会话并返回 brief。开工只调这一次，直接用返回的 brief。 | false | false | `021d4467dcbd346b` |
| core | `atm_brief` | 重新取回 working set。仅在上下文压缩、长时间离开或明确恢复时调用。 | true | false | `7422e81af5f92132` |
| core | `atm_task_list` | 分页列任务。view=core\|context\|full\|reconcile。field_mask 语义同 atm_task_get。 | true | false | `a7bec8288383d879` |
| core | `atm_task_get` | 读单个任务。view=core\|context\|full。field_mask 在 view 已有的字段内过滤，越界字段会回显在 ignored_fields。 | true | false | `705783aac353593c` |
| core | `atm_task_create` | 批量创建任务与关系。 | false | false | `a952231938cc2768` |
| core | `atm_end` | 结束会话并交接。outcome=completed\|paused\|blocked\|cancelled\|error\|retired，全小写。summary 上限 500 个 code point。 | false | false | `a5e10baa5437bb15` |
| memory | `atm_progress_add` | 写任务或项目进度。scope=task\|project；health=ON_TRACK\|AT_RISK\|OFF_TRACK\|UNKNOWN，仅限 project；percent 仅限 task。task 的非空 blocker 会转为 BLOCKED 并清除等待对象；普通说明请写 summary。summary 上限 500 个 code point。 | false | false | `65a68de06d4cfcc8` |
| memory | `atm_record` | 保存关键记录。kind=DECISION\|CONSTRAINT\|FACT\|RISK\|REFERENCE\|LESSON；importance=LOW\|NORMAL\|HIGH\|CRITICAL。summary 上限 300 个 code point，长内容放 detail。 | false | false | `1295ceac3e229287` |
| memory | `atm_feedback` | 提交仅存本机的 ATM 使用反馈。severity=LOW\|NORMAL\|HIGH\|CRITICAL。 | false | false | `03389ebe6d38b74c` |
| memory | `atm_search` | 搜索事实。session 只能与 op_id 精确回查一起传。 | true | false | `1ad9185e31d74bf9` |
| memory | `atm_delta` | 读增量变化。 | true | false | `6441973a372b0bbb` |
| memory | `atm_knowledge_search` | 搜索本地共享知识的摘要与适用范围。 | true | false | `8e25620829d4e8dc` |
| memory | `atm_knowledge_get` | 读取固定修订，part=body\|metadata（默认 body）。编辑用 for_edit=true；metadataTruncated 时按 metadataRead 续读，各页 metadataJson 拼接后解析。沿 cursor 读完整再保存。 | true | false | `fdfec61a2bf88c95` |
| memory | `atm_knowledge_save` | 直接发布共享知识，无需手工导入。先查重；更新须带 id 和 expected_revision_id，并提交完整内容；新建省略二者。重试复用 op_id。 | false | false | `700dd274ffe76554` |
| actions | `atm_task_patch` | 批量变更任务。items 每条都要 task_key 与 expected_version，operation 取值：claim\|start\|release\|block\|wait_agent\|wait_user\|verify\|complete\|cancel\|reopen\|edit\|verify_and_complete\|review_request\|review_submit\|checklist_single\|checklist_batch。verify_and_complete\|review_request\|review_submit\|checklist_single\|checklist_batch 不可与其他操作同批，items 只允许一个元素。complete 还要求任务当前处于 IN_PROGRESS 或 VERIFYING，没开工过的先 start。 | false | true | `e14425f3858e5f7a` |

## Legacy compatibility artifact

The unprofiled migration endpoint publishes the frozen v1.0.18 artifact from commit `410969b7fed5f1837078f6731271bf6c18381faf`: 11064 bytes, SHA-256 `8fab5e1eff857b3e7d0265d417c0da195194431e0cee37fdc95e4b1a3337a6d7`. Current installers only create the formal core, memory and actions profiles.
