import { describe, expect, it } from "vitest";
import { RecordInputSchema } from "../src/index.js";

const validRecord = (overrides: Record<string, unknown> = {}) => ({
  project: "ATM",
  session: "session-1",
  opId: "record-topic-subject",
  kind: "FACT",
  title: "Record topic input",
  summary: "Record topic and subject key must survive public parsing.",
  ...overrides,
});

describe("Record topic/subjectKey protocol", () => {
  it.each(["VERIFICATION", "WAIVER"])(
    "accepts the %s kind already supported by storage and the UI",
    (kind) => {
      expect(RecordInputSchema.parse(validRecord({ kind })).kind).toBe(kind);
    },
  );

  it("preserves trimmed camelCase topic and a stable non-WorkItem subjectKey", () => {
    expect(
      RecordInputSchema.parse(
        validRecord({ topic: "  release/1.0.16  ", subjectKey: "  candidate:future-v99  " }),
      ),
    ).toMatchObject({
      topic: "release/1.0.16",
      subjectKey: "candidate:future-v99",
    });
  });

  it.each([
    ["blank", "   "],
    ["overlong", `a${"b".repeat(200)}`],
    ["whitespace", "candidate future"],
    ["control character", "candidate\u0000future"],
  ])("rejects %s subjectKey input", (_case, subjectKey) => {
    const result = RecordInputSchema.safeParse(validRecord({ subjectKey }));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["subjectKey"]);
  });
});
