import { describe, expect, it } from "vitest";
import {
  legalWorkItemOperations,
  resolveWorkItemOperation,
  WorkItemOperations,
  workItemOperationHasEffect,
  workItemStatusLabel,
} from "../src/index.js";

describe("工作项状态协议", () => {
  it("按操作身份解析目标并为界面提供中文标签", () => {
    expect(workItemStatusLabel("IN_PROGRESS")).toBe("进行中");
    expect(
      resolveWorkItemOperation("claim", { currentStatus: "READY", phase: "READY" }).target,
    ).toBe("CLAIMED");
    expect(legalWorkItemOperations("CLAIMED")).toEqual([
      { operation: "claim", target: "CLAIMED" },
      { operation: "start", target: "IN_PROGRESS" },
      { operation: "release", target: "READY" },
      { operation: "block", target: "BLOCKED" },
      { operation: "complete", target: "DONE" },
      { operation: "cancel", target: "CANCELLED" },
      { operation: "edit", target: "CLAIMED" },
    ]);
    expect(() =>
      resolveWorkItemOperation("verify", { currentStatus: "CLAIMED", phase: "CLAIMED" }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_TRANSITION",
        details: expect.objectContaining({
          operation: "verify",
          current_status: "CLAIMED",
          requested_status: "VERIFYING",
          legal_operations: ["claim", "start", "release", "block", "complete", "cancel", "edit"],
        }),
      }),
    );
  });

  it("VERIFYING 可进入等待状态，等待状态 reopen 按 phase 恢复", () => {
    expect(legalWorkItemOperations("VERIFYING")).toEqual(
      expect.arrayContaining([
        { operation: "wait_agent", target: "WAITING_AGENT" },
        { operation: "wait_user", target: "WAITING_USER" },
      ]),
    );
    expect(
      resolveWorkItemOperation("reopen", {
        currentStatus: "WAITING_AGENT",
        phase: "VERIFYING",
      }).target,
    ).toBe("VERIFYING");
    expect(
      resolveWorkItemOperation("reopen", {
        currentStatus: "WAITING_USER",
        phase: "IN_PROGRESS",
      }).target,
    ).toBe("IN_PROGRESS");
  });

  it("Registry 暴露前置条件、同态幂等与应用层 effects", () => {
    expect(WorkItemOperations.start.homomorphicFrom).toContain("IN_PROGRESS");
    expect(WorkItemOperations.complete.homomorphicFrom).not.toContain("DONE");
    expect(WorkItemOperations.complete.preconditions).toContain("COMPLETION_GATE");
    expect(workItemOperationHasEffect("verify", "REFRESH_GIT_CONTEXT")).toBe(true);
    expect(workItemOperationHasEffect("claim", "ESTABLISH_ENGINEERING_BASELINE")).toBe(true);
    expect(workItemOperationHasEffect("cancel", "CAPTURE_ENGINEERING_METRICS")).toBe(true);
    expect(workItemOperationHasEffect("start", "SESSION_WORKING")).toBe(true);
    expect(workItemOperationHasEffect("block", "SESSION_WAITING")).toBe(true);
    expect(workItemOperationHasEffect("complete", "SESSION_IDLE")).toBe(true);
  });
});
