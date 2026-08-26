import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RECORD_SUMMARY_CODE_POINT_LIMIT,
  RecordInputSchema,
  RecordSummarySchema,
  unicodeCodePointLength,
} from "../src/index.js";

function record(summary: string) {
  return {
    project: "UNICODE",
    session: "session-1",
    opId: "record-summary-boundary",
    kind: "FACT" as const,
    title: "Unicode 摘要边界",
    summary,
    detail: "",
  };
}

describe("Record summary Unicode code point 上限", () => {
  it("接受 300 个 code point，并保留 JSON Schema maxLength 元数据", () => {
    const summary = "界".repeat(300);

    expect(unicodeCodePointLength(summary)).toBe(300);
    expect(RECORD_SUMMARY_CODE_POINT_LIMIT).toBe(300);
    expect(RecordInputSchema.parse(record(summary)).summary).toBe(summary);
    const summaryJsonSchema = z.toJSONSchema(RecordSummarySchema);
    const recordJsonSchema = z.toJSONSchema(RecordInputSchema) as {
      properties?: { summary?: Record<string, unknown> };
    };

    expect(summaryJsonSchema).toMatchObject({
      type: "string",
      maxLength: 300,
    });
    expect(recordJsonSchema.properties?.summary).toMatchObject({
      type: "string",
      maxLength: 300,
    });
  });

  it("按 code point 接受 200 个 emoji，而不是按 UTF-16 code unit 双计", () => {
    const summary = "😀".repeat(200);

    expect(summary.length).toBe(400);
    expect(unicodeCodePointLength(summary)).toBe(200);
    expect(RecordInputSchema.parse(record(summary)).summary).toBe(summary);
  });

  it("拒绝 301 个 code point，并在 issue 中暴露统一上限", () => {
    const summary = "界".repeat(301);
    const result = RecordInputSchema.safeParse(record(summary));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "too_big",
          path: ["summary"],
          maximum: 300,
        }),
      ]),
    );
  });
});
