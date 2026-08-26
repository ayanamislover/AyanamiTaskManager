import { describe, expect, it } from "vitest";
import {
  assertWorkItemTransition,
  legalWorkItemOperations,
  workItemStatusLabel,
} from "../src/index.js";

describe("工作项状态协议", () => {
  it("只允许规格声明的迁移并为界面提供中文标签", () => {
    expect(workItemStatusLabel("IN_PROGRESS")).toBe("进行中");
    expect(() => assertWorkItemTransition("READY", "CLAIMED")).not.toThrow();
    expect(legalWorkItemOperations("CLAIMED")).toEqual([
      { operation: "start", target: "IN_PROGRESS" },
      { operation: "release", target: "READY" },
      { operation: "cancel", target: "CANCELLED" },
    ]);
    expect(() => assertWorkItemTransition("CLAIMED", "VERIFYING")).toThrowError(
      "INVALID_TRANSITION: CLAIMED -> VERIFYING (legal operations from CLAIMED: start -> IN_PROGRESS, release -> READY, cancel -> CANCELLED)",
    );
  });

  it("VERIFYING 可正交进入等待用户或等待 Agent 的兼容状态", () => {
    expect(legalWorkItemOperations("VERIFYING")).toEqual(
      expect.arrayContaining([
        { operation: "wait_agent", target: "WAITING_AGENT" },
        { operation: "wait_user", target: "WAITING_USER" },
      ]),
    );
    expect(() => assertWorkItemTransition("VERIFYING", "WAITING_AGENT")).not.toThrow();
    expect(() => assertWorkItemTransition("VERIFYING", "WAITING_USER")).not.toThrow();
  });
});
