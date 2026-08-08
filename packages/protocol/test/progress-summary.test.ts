import { describe, expect, it } from "vitest";
import { ProgressAddInputSchema } from "../src/index.js";

function input(summary: string) {
  return {
    project: "ATM",
    session: "session-progress-limit",
    opId: "progress-summary-limit",
    scope: "project" as const,
    summary,
  };
}

describe("进度摘要协议边界", () => {
  it("接受 500 字摘要并拒绝 501 字摘要", () => {
    expect(ProgressAddInputSchema.parse(input("进".repeat(500))).summary).toHaveLength(500);
    expect(() => ProgressAddInputSchema.parse(input("进".repeat(501)))).toThrow();
  });
});
