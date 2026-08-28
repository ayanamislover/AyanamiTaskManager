export const MUTATION_ACK_CONTRACT = Object.freeze({
  fields: [
    "ok",
    "op_id",
    "project",
    "session",
    "session_rebound",
    "projection",
    "entities",
    "entity_count",
    "entities_truncated",
    "details_cursor",
  ] as const,
  entityPreview: Object.freeze({ maxItems: 12, maxChars: 1800 }),
  detailsCursor: Object.freeze({
    name: "atm_search" as const,
    fieldMask: ["op_id", "entities"] as const,
    maxChars: 50_000,
  }),
  operationDetailsFieldMask: ["op_id", "mutations"] as const,
});

export const MUTATION_ACK_DOCUMENTATION_BEGIN = "<!-- MUTATION_ACK_CONTRACT:BEGIN -->";
export const MUTATION_ACK_DOCUMENTATION_END = "<!-- MUTATION_ACK_CONTRACT:END -->";

const FIELD_DESCRIPTIONS: Readonly<Record<(typeof MUTATION_ACK_CONTRACT.fields)[number], string>> =
  Object.freeze({
    ok: "写操作是否被 ATM 接受。",
    op_id: "调用方提交的幂等操作 ID；重试必须复用。",
    project: "规范化后的项目代码。",
    session: "实际承载写操作的 Session。",
    session_rebound: "Session 过期并由 ATM 安全接续时为 `true`。",
    projection:
      "Registry 投影持久回执；含 `status`、`source_seq`、`projected_seq`、`retry_scheduled`、`last_error` 与累计 `retry_count`。`DEFERRED` 表示权威写已成功且后台会重试。",
    entities: "受影响实体的有界预览，每项含 `entity_type`、`key`、`version`。",
    entity_count: "完整受影响实体数量，不受预览截断影响。",
    entities_truncated: "实体预览是否被条数或字符预算截断。",
    details_cursor: "可直接作为 MCP 工具调用执行的有界 durable 实体回查描述符。",
  });

function toolCall(fieldMask: readonly string[]): string {
  return JSON.stringify(
    {
      name: MUTATION_ACK_CONTRACT.detailsCursor.name,
      arguments: {
        project: "ATM",
        op_id: "<same-op-id>",
        session: "<returned-session>",
        field_mask: fieldMask,
        max_chars: MUTATION_ACK_CONTRACT.detailsCursor.maxChars,
      },
    },
    null,
    2,
  );
}

export function generateMutationAcknowledgementDocumentation(): string {
  const rows = MUTATION_ACK_CONTRACT.fields.map(
    (field) => `| \`${field}\` | ${FIELD_DESCRIPTIONS[field]} |`,
  );
  return [
    MUTATION_ACK_DOCUMENTATION_BEGIN,
    "### 固定 mutation ACK",
    "",
    "所有 mutation 工具只返回同一组有界字段；不要依赖操作特有的顶层字段。",
    "",
    "| 字段 | 语义 |",
    "| --- | --- |",
    ...rows,
    "",
    `\`entities\` 最多预览 ${MUTATION_ACK_CONTRACT.entityPreview.maxItems} 项且不超过 ${MUTATION_ACK_CONTRACT.entityPreview.maxChars} 个 JSON 字符。以 \`entity_count\` 判断精确总数；\`entities_truncated=true\` 时可直接执行返回的 \`details_cursor\` 做一次最多 ${MUTATION_ACK_CONTRACT.detailsCursor.maxChars} 字符的 durable 回查：`,
    "",
    "```json",
    toolCall(MUTATION_ACK_CONTRACT.detailsCursor.fieldMask),
    "```",
    "",
    "需要操作特有结果时，仍以同一 `project`、`op_id` 和返回的 `session` 精确读取 durable operation receipt，只把 `field_mask` 改为下例；不要重新执行 mutation：",
    "",
    "```json",
    toolCall(MUTATION_ACK_CONTRACT.operationDetailsFieldMask),
    "```",
    "",
    "例如自动补建规划根的事实位于 `operation.mutations[].response.planningRootProvisioned`；mutation ACK 顶层不再返回 `planning_root`。字段读取若返回 `done=false`，把 `next_cursor` 作为 `cursor` 加回同一个 `atm_search` 调用继续读，直到 `done=true`。",
    MUTATION_ACK_DOCUMENTATION_END,
  ].join("\n");
}
