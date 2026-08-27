import { ChecklistBatchFailureError } from "@ayanami-task/protocol";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { describe, expect, it } from "vitest";
import { buildAyanamiServer } from "../src/index.js";

describe("checklist batch typed error details", () => {
  it("returns the complete ordered reason list through REST", async () => {
    const reasons = [
      {
        task_key: "ATM-T-0001",
        code: "VERSION_CONFLICT" as const,
        expected: 3,
        actual: 4,
      },
      { checklist_id: "check-1", code: "EVIDENCE_REQUIRED" as const },
      { checklist_id: "check-2", code: "TASK_MISMATCH" as const },
      { checklist_id: "check-3", code: "NOT_FOUND" as const },
    ];
    const service = {
      updateChecklistBatch: async () => {
        throw new ChecklistBatchFailureError(reasons);
      },
    } as unknown as AyanamiTaskService;
    const app = await buildAyanamiServer({ service, token: "local-secret" });

    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/projects/ATM/checklist/batch",
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: "session-1",
          opId: "batch-error-details",
          taskKey: "ATM-T-0001",
          expectedVersion: 3,
          items: [{ checklistId: "check-1", status: "DONE" }],
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: "COMPLETION_GATE_FAILED",
          details: { reasons },
        },
      });
    } finally {
      await app.close();
    }
  });
});
