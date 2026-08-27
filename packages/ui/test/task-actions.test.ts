import { describe, expect, it } from "vitest";
import { workItemUiActions } from "../src/task-actions.js";

const operations = (status: Parameters<typeof workItemUiActions>[0]["status"], stale = false) =>
  workItemUiActions({ status, actor: "USER", claimOwner: "agent", claimStale: stale }).map(
    ({ operation, label }) => [operation, label],
  );

describe("canonical WorkItem UI actions", () => {
  it("projects status-specific labels and availability from the registry", () => {
    expect(operations("BACKLOG")).toEqual([
      ["start", "开始"],
      ["cancel", "取消"],
    ]);
    expect(operations("IN_PROGRESS")).toEqual([
      ["block", "阻塞"],
      ["wait_agent", "等待 Agent"],
      ["wait_user", "等待用户"],
      ["verify", "提交验收"],
      ["cancel", "取消"],
    ]);
    expect(operations("VERIFYING")).toEqual([
      ["complete", "完成"],
      ["reopen", "退回"],
    ]);
  });

  it("only exposes release for a stale claim and keeps terminal reopen available", () => {
    expect(operations("CLAIMED")).toEqual([["cancel", "取消"]]);
    expect(operations("CLAIMED", true)).toEqual([
      ["release", "释放过期领取"],
      ["cancel", "取消"],
    ]);
    expect(operations("DONE")).toEqual([["reopen", "重新打开"]]);
  });

  it("uses explicit actor/claim-owner context for claim-owner operations", () => {
    const foreign = workItemUiActions({
      status: "CLAIMED",
      actor: "agent-b",
      claimOwner: "agent-a",
      claimStale: false,
    });
    expect(foreign.some(({ operation }) => operation === "release")).toBe(false);
  });
});
