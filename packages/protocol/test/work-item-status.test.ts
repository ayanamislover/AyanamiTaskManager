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
});
