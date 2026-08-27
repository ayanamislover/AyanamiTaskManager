import { ChecklistBatchFailureDetailsSchema, ChecklistBatchFailureError } from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("checklist batch failure contract", () => {
  it("keeps typed reasons ordered and rejects unbounded extra fields", () => {
    const reasons = [
      {
        task_key: "ATM-T-0001",
        code: "VERSION_CONFLICT" as const,
        expected: 3,
        actual: 4,
      },
      { checklist_id: "check-1", code: "NOT_FOUND" as const },
    ];
    const error = new ChecklistBatchFailureError(reasons);

    expect(error).toMatchObject({
      code: "COMPLETION_GATE_FAILED",
      details: { reasons },
    });
    expect(ChecklistBatchFailureDetailsSchema.safeParse(error.details).success).toBe(true);
    expect(
      ChecklistBatchFailureDetailsSchema.safeParse({
        reasons: [{ checklist_id: "check-1", code: "NOT_FOUND", leaked: "no" }],
      }).success,
    ).toBe(false);
  });
});
