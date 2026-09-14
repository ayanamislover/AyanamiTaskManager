# 本地共享知识库

ATM 的本地共享知识库为同一数据根下的多个项目提供可版本化的参考资料。在线事实源是
`<ATM_DATA_DIR>/knowledge/knowledge.sqlite`；Markdown 导入/导出是副本，不是第二个事实源。
知识库与项目库独立，来源项目归档或删除不会使已经发布的知识修订失效。

## Agent 读取流程

知识只通过 memory Profile 的两个只读 MCP 工具按需读取：

1. `atm_knowledge_search` 先返回候选元数据（标题、摘要、使用场景、标签、适用范围和当前修订号），不返回正文。
2. 根据适用范围选择条目，再用 `atm_knowledge_get` 读取条目正文或 Markdown 章节。
3. 采用重要结论时记录稳定引用 `id@revisionId`；响应中的数字 `revision` 仅用于展示。正文续读沿用返回的 `cursor`，并保持同一 `id` 和实际 `revisionId`。

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

`atm_knowledge_get` 的输入为 `id`，可选不可变 `revision_id`、`section`、`max_chars` 和 `cursor`。
输入由 `packages/protocol/src/inputs/knowledge.ts` 的 canonical Zod 契约校验。

知识读取响应保留 canonical application view 的 camelCase 字段（例如 `hasMore`、`nextCursor`、
`bodyMarkdown`、`useWhen`、`sourceRefs`）。这是有意的 typed view：服务端在相同形状上计算并验证
`maxChars`，避免外层字段转换造成响应越界；不要把响应字段名与 MCP 输入字段名混用。

搜索游标绑定当时的知识目录序列。条目发生变更后，搜索分页会明确要求重新搜索；正文游标绑定
不可变的数据库身份、恢复代次、条目 ID 和 revisionId，与无关条目变更及正常重启无关。找不到原修订时
应省略 cursor 并重新指定 ID/revisionId，而不是把新旧正文拼接。

默认搜索隐藏归档条目；需要目录维护时才显式传 `include_archived: true`。字符预算不足会返回
明确的 `RESULT_TOO_LARGE`，不得用空结果和原 cursor 自循环。

## 权限与分发边界

知识正文是参考材料。正文中的命令片段不会自动执行，也不会授予执行脚本、访问额外目录、读取
任意文件或覆盖当前用户要求的权限；当前任务的明确指令和项目约束优先于通用知识。

`knowledge.sqlite`、导入资料和导出文件属于用户数据，不进入安装包的 Agent 文档/Skill manifest，
也不会因升级或修复内置 Skill 被覆盖。安装包只携带 `ATM_AGENT_GUIDE.md`、文档和通用
`atm-knowledge` Skill。用户引用应使用 `entryId@revisionId`，不能只记录会在恢复后重用的数字 revision。
