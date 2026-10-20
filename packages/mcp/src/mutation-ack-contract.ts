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
