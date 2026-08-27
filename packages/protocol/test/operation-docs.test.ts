import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  generateWorkItemOperationTable,
  WORK_ITEM_OPERATION_TABLE_BEGIN,
  WORK_ITEM_OPERATION_TABLE_END,
} from "../src/index.js";

function markedSection(content: string): string {
  const start = content.indexOf(WORK_ITEM_OPERATION_TABLE_BEGIN);
  const end = content.indexOf(WORK_ITEM_OPERATION_TABLE_END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return content.slice(start, end + WORK_ITEM_OPERATION_TABLE_END.length);
}

describe("generated WorkItem operation documentation", () => {
  it("keeps the Guide and generated contract synchronized with the registry", () => {
    const expected = generateWorkItemOperationTable();
    expect(markedSection(readFileSync("ATM_AGENT_GUIDE.md", "utf8"))).toBe(expected);
    expect(markedSection(readFileSync("docs/generated/work-item-operations.md", "utf8"))).toBe(
      expected,
    );
  });
});
