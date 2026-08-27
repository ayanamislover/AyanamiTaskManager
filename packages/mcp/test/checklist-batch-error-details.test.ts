import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { ChecklistBatchFailureError } from "@ayanami-task/protocol";
import { describe, expect, it } from "vitest";
import { createAyanamiMcpServer } from "../src/index.js";

describe("checklist batch typed error details", () => {
  it("preserves the complete ordered reason list in structuredContent", async () => {
    const reasons = [
      {
        task_key: "ATM-T-0001",
        code: "VERSION_CONFLICT" as const,
        expected: 3,
        actual: 4,
      },
      { checklist_id: "check-1", code: "EVIDENCE_REQUIRED" as const },
      ...Array.from({ length: 99 }, (_, index) => ({
        checklist_id: `check-${String(index + 2).padStart(3, "0")}`,
        code: index % 2 === 0 ? ("TASK_MISMATCH" as const) : ("NOT_FOUND" as const),
      })),
    ];
    const service = {
      updateChecklistBatch: async () => {
        throw new ChecklistBatchFailureError(reasons);
      },
    } as unknown as AyanamiTaskService;
    const server = createAyanamiMcpServer(service, { profile: "memory" });
    const client = new Client({ name: "checklist-batch-error-details", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const response = await client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: "ATM",
          session: "session-1",
          op_id: "batch-error-details",
          items: [
            {
              task_key: "ATM-T-0001",
              expected_version: 3,
              operation: "checklist_batch",
              checklist_items: [{ id: "check-1", status: "DONE" }],
            },
          ],
        },
      });
      const text = String((response.content[0] as { text?: unknown } | undefined)?.text ?? "");
      expect(response.isError).toBe(true);
      expect(text).toContain("COMPLETION_GATE_FAILED");
      expect(text).not.toContain("MCP_DETAILS=");
      const details = (response.structuredContent as { details: Record<string, unknown> }).details;
      expect(details).toEqual({ reasons });
      expect(details.reasons).toHaveLength(101);
      expect(details).not.toHaveProperty("truncated");
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
