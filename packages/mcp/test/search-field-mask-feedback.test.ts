import { describe, expect, it } from "vitest";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { createAtmSearchTool } from "../src/tools/memory/search.js";

const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const session = {
  id,
  agentId: "reviewer",
  connectionState: "CLOSED",
  closedAt: "2026-09-19T00:00:00Z",
  version: 1,
};
const service = {
  getSession: async () => session,
  agentPage: async () => ({
    items: [session],
    hasMore: false,
    nextCursor: null,
    itemCursors: ["next"],
    retryCursor: "start",
  }),
  search: async () => ({
    hits: [
      {
        entityType: "RECORD",
        entityKey: "MASK-R-0001",
        title: "test",
        snippet: "match",
        updatedAt: "today",
      },
    ],
    hasMore: false,
    nextCursor: null,
  }),
} as unknown as AyanamiTaskService;
const tool = createAtmSearchTool(service);
const read = async (input: Record<string, unknown>) => {
  const result = await tool.handler(
    tool.inputSchema.parse({ project: "MASK", ...input }),
    {} as never,
  );
  return result.structuredContent as Record<string, any>;
};

describe("search masks distinguish a wrong field from absent data", () => {
  it("echoes unknown exact-session fields without discarding a valid id", async () => {
    const result = await read({
      query: `session:${id}`,
      field_mask: ["id", "summary", "ended_at"],
      max_chars: 300,
    });
    expect(result.entity.id).toBe(id);
    expect(result.ignored_fields).toEqual(["summary", "ended_at"]);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(300);
    const valid = await read({ query: `session:${id}`, field_mask: ["id"] });
    expect(valid.ignored_fields).toBeUndefined();
  });
  it("bounds large echoes and covers list and full-text channels", async () => {
    const unknown = Array.from({ length: 20 }, (_, i) => `typo_${i}${"x".repeat(50)}`);
    for (const input of [{ query: `session:${id}` }, { list: "sessions" }, { query: "test" }]) {
      const result = await read({ ...input, field_mask: unknown, max_chars: 300 });
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(300);
      expect(result.ignored_fields.length + result.ignored_fields_omitted).toBe(20);
    }
  });
});
