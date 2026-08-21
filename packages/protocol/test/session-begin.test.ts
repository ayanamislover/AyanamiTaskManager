import { describe, expect, it } from "vitest";

import { BeginInputSchema } from "../src/index.js";

describe("atomic Session begin protocol", () => {
  it("normalizes an optional operationId and rejects empty or oversized identities", () => {
    const parsed = BeginInputSchema.parse({
      operationId: " session-begin-exact ",
      projectCode: "CAH",
      mode: "project",
      agentId: "codex-primary",
    });
    expect(parsed.operationId).toBe("session-begin-exact");

    expect(() =>
      BeginInputSchema.parse({
        operationId: "   ",
        projectCode: "CAH",
        mode: "project",
        agentId: "codex-primary",
      }),
    ).toThrow();
    expect(() =>
      BeginInputSchema.parse({
        operationId: "x".repeat(129),
        projectCode: "CAH",
        mode: "project",
        agentId: "codex-primary",
      }),
    ).toThrow();
  });
});
