import { describe, expect, it } from "vitest";
import { ReviewRequestCreateInputSchema, ReviewSubmitInputSchema } from "../src/index.js";

describe("一等 Review 工作流协议", () => {
  it("接收公开 Review/checklist 引用、候选 hashes 与结构化 verdict 证据", () => {
    expect(
      ReviewRequestCreateInputSchema.parse({
        project: "ATM",
        session: "primary-session",
        opId: "review-request-1",
        reviewTaskKey: "ATM-T-0002",
        expectedReviewTaskVersion: 3,
        parentChecklistId: "checklist-1",
        expectedParentChecklistVersion: 1,
        expectedCandidateHashes: [
          { name: "git_head", value: "A".repeat(40) },
          { name: "worktree", value: "B".repeat(64) },
        ],
      }),
    ).toMatchObject({ reviewTaskKey: "ATM-T-0002" });

    expect(
      ReviewSubmitInputSchema.parse({
        project: "ATM",
        session: "review-session",
        opId: "review-submit-1",
        requestKey: "ATM-RR-0001",
        expectedReviewTaskVersion: 5,
        verdict: "APPROVED",
        reviewedHashes: [
          { name: "git_head", value: "a".repeat(40) },
          { name: "worktree", value: "b".repeat(64) },
        ],
        evidence: [{ kind: "test_result", value: "review-gate: passed" }],
      }),
    ).toMatchObject({ verdict: "APPROVED" });
  });

  it("拒绝非十六进制 hash、重复 hash 名称与非结构化 evidence", () => {
    const base = {
      project: "ATM",
      session: "review-session",
      opId: "review-submit-invalid",
      requestKey: "ATM-RR-0001",
      expectedReviewTaskVersion: 5,
      verdict: "CHANGES_REQUESTED",
      evidence: [{ kind: "test_result", value: "review-gate: failed" }],
    };
    expect(() =>
      ReviewSubmitInputSchema.parse({
        ...base,
        reviewedHashes: [{ name: "git_head", value: "not-a-hash" }],
      }),
    ).toThrow();
    expect(() =>
      ReviewSubmitInputSchema.parse({
        ...base,
        reviewedHashes: [
          { name: "Git_Head", value: "a".repeat(40) },
          { name: "git_head", value: "a".repeat(40) },
        ],
      }),
    ).toThrow();
    expect(() =>
      ReviewSubmitInputSchema.parse({
        ...base,
        reviewedHashes: [{ name: "git_head", value: "a".repeat(40) }],
        evidence: ["plain text is not structured"],
      }),
    ).toThrow();
  });
});
