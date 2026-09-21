# 本地共享知识库

ATM 的本地共享知识库为同一数据根下的多个项目提供可版本化的参考资料。在线事实源是
`<ATM_DATA_DIR>/knowledge/knowledge.sqlite`；Markdown 导入/导出是副本，不是第二个事实源。
知识库与项目库独立，来源项目归档或删除不会使已经发布的知识修订失效。

## Agent 读取流程

知识只通过 memory Profile 的两个只读 MCP 工具按需读取：

1. `atm_knowledge_search` 先返回候选元数据（标题、摘要、使用场景、标签、适用范围和不可变 `revisionId`），不返回正文。
2. 根据适用范围选择条目，再用 `atm_knowledge_get` 读取条目正文或 Markdown 章节。
3. 采用重要结论时记录稳定引用 `id@revisionId`；仅 REST 管理视图中的数字 `revision` 用于展示，MCP 不返回它。正文续读沿用返回的 `cursor`，并保持同一 `id` 和实际 `revisionId`。

工具不要求 `project` 或 Session；知识是同一 ATM 数据根内的共享参考资料，不构成项目权限边界。

## MCP 参数与响应

MCP 参数统一使用 `snake_case`：

```json
{
  "query": "接口兼容",
  "include_archived": false,
  "limit": 5,
  "max_chars": 2400
}
```

`atm_knowledge_get` 的输入为 `id`，可选不可变 `revision_id`、`section`、`max_chars` 和 `cursor`。`section` 可用目录中的章节 ID，或唯一的章节标题；重名时明确返回候选 ID，不猜测。
输入由 `packages/protocol/src/inputs/knowledge.ts` 的 canonical Zod 契约校验。

`bodyMarkdown` 与搜索 `query` 不接受 U+0000（NUL）。短于三字的查询用不了 trigram FTS，只能用 LIKE 扫正文，而 SQLite 的 LIKE 把 NUL 当作字符串终点——含 NUL 的正文会保存成功、读回逐字相等、三字以上的 FTS 查询照常命中，唯独短查询搜不到 NUL 之后的内容。与其让一条存进去的知识有一半搜不着，契约在入口就拒绝它；NUL 在 Markdown 里不承载任何内容。

知识读取响应使用应用层 canonical Agent view 的 camelCase 字段（例如 `hasMore`、`nextCursor`、
`bodyMarkdown`、`useWhen`、`sourceRefs`），不要和 MCP 的 snake_case 输入混用。REST 保留完整管理视图；
MCP 搜索不返回 slug、显示序号、编辑 version、时间等管理字段。首次正文读取保留适用条件、来源和目录；
续页只返回 `id`、`revisionId`、`archived`、`bodyMarkdown`、`truncated`、`nextCursor`，不重复元数据。
字符预算直接作用于最终 Agent 投影，而不是先裁完整 REST 页再删除字段；相同预算可以容纳更多有效正文。

Agent 首屏目录也是摘要：最多 40 项、每个标题最多 120 字符，并随预算收缩；`tocTotal` 和 `tocTruncated` 明示省略。全文不被截掉，仍可沿正文 cursor 读取，或直接用唯一章节标题定位，不必先把整份目录送进上下文。

搜索游标绑定当时的知识目录序列。条目发生变更后，搜索分页会明确要求重新搜索；正文游标绑定
不可变的数据库身份、恢复代次、条目 ID 和 revisionId，与无关条目变更及正常重启无关。找不到原修订时
应省略 cursor 并重新指定 ID/revisionId，而不是把新旧正文拼接。

默认搜索隐藏归档条目；需要目录维护时才显式传 `include_archived: true`。字符预算不足会返回
明确的 `RESULT_TOO_LARGE`，不得用空结果和原 cursor 自循环。

## 高信息密度写作

先搜索已有主题，避免重复条目；摘要写可用于筛选的结论与使用场景。正文按“结论、最短操作、验收/失败边界、必要依据”组织，保留版本、前提和例外，不保存冗长的开发流水账。同一主题新增修订，项目专属事实留在 Record；跨项目使用时记录 `id@revisionId`，不把全文复制到各项目。未知与未验证应明示，不能为了省字丢关键约束，也不为填满预算凑字。

## Agent 直接发布与更新

`atm_knowledge_save` 是 memory Profile 的写入口。Agent 可直接沉淀受管工作中的可复用结论，不需要用户逐篇手工导入或点发布；不在每次 complete/end 自动生成知识，不把未验证推断表述为事实。

先查重。新建传活动会话 `project`、`session`、唯一 `op_id`，以及 `slug/title/summary/body_markdown`；`use_when/tags/aliases/applies_to/source_refs` 按需提供。来源内部使用 `type/reference/sourceVersion/projectId/recordId`，type 仅支持 `file/url/manual/project_record`，git 提交可记录为 manual 来源。

更新前 `atm_knowledge_get(id, for_edit=true)` 获取正文及 `edit`（slug、summary、tags、aliases）；首屏还包含 title/useWhen/appliesTo/sourceRefs。沿固定 revision_id 与 cursor 读完整篇，不使用 section 裁片覆盖正文。合并后提交完整内容及 `id/expected_revision_id`；省略可选字段会重置，不是 PATCH。普通只读查询保持原有紧凑输出。

保存生成不可变修订，旧引用仍然有效。服务验证 project 下的活动 Session，作者 `publishedBy` 从数据库读取，不能声明自己为 USER。知识库事务原子提交正文、索引和幂等回执，不伪称同时提交项目库。相同会话相同 op_id 的完全相同请求返回原结果；改内容复用 op_id 被拒绝。更新基线过期返回 VERSION_CONFLICT，必须重读合并；归档条目不能通过此工具静默恢复。

回执为 `ok/op_id/id/revisionId/version/reference/publishedBy`，不回传正文，不走项目 mutation ACK。`reference` 可直接记为长期引用。会话已结束时重新 atm_begin 并先查询确认原发布结果，不能换 op_id 盲目重建。只读 search/get 仍然不需要会话。旧客户端看不到工具时升级 ATM 并重载 MCP。

知识正文不因发布自动执行，不授予额外权限；不写入密钥或无关隐私。未验证的部分必须保留适用前提与不确定性。Markdown 导入当前支持 `---json` 元数据头；YAML 头不会被解析为元数据，Agent 应直接传结构化字段，不再依赖文件搬运。

## 权限与分发边界

知识正文是参考材料。正文中的命令片段不会自动执行，也不会授予执行脚本、访问额外目录、读取
任意文件或覆盖当前用户要求的权限；当前任务的明确指令和项目约束优先于通用知识。

`knowledge.sqlite`、导入资料和导出文件属于用户数据，不进入安装包的 Agent 文档/Skill manifest，
也不会因升级或修复内置 Skill 被覆盖。安装包只携带 `ATM_AGENT_GUIDE.md`、文档和通用
`atm-knowledge` Skill。用户引用应使用 `entryId@revisionId`，不能只记录会在恢复后重用的数字 revision。
