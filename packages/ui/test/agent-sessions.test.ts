import { describe, expect, it } from "vitest";
import {
  findAgentSessionConflicts,
  groupAgentSessions,
  summarizeAgentSessions,
} from "../src/agent-sessions.js";

const session = (
  id: string,
  agentId: string,
  project: string,
  state: "ONLINE" | "CLOSED",
  lastSeenAt: string,
) => ({
  id,
  agentId,
  project,
  role: "PRIMARY",
  displayName: agentId,
  connectionState: state,
  lastSeenAt,
});

describe("Agent Git context conflicts", () => {
  it("提示两个活动 Session 共用同一 Worktree", () => {
    expect(
      findAgentSessionConflicts([
        {
          ...session("one", "codex", "ATM", "ONLINE", "2026-08-08T12:00:00Z"),
          git: { worktreeRoot: "R:\\repo" },
        },
        {
          ...session("two", "claude", "ATM", "ONLINE", "2026-08-08T12:01:00Z"),
          git: { worktreeRoot: "r:\\repo" },
        },
      ]),
    ).toContainEqual(expect.objectContaining({ kind: "SAME_WORKTREE", count: 2 }));
  });

  it("提示两个活动 Session 共用同一 branch", () => {
    expect(
      findAgentSessionConflicts([
        {
          ...session("one", "codex", "ATM", "ONLINE", "2026-08-08T12:00:00Z"),
          git: { branch: "feature/shared", worktreeRoot: "R:\\one" },
        },
        {
          ...session("two", "claude", "ATM", "ONLINE", "2026-08-08T12:01:00Z"),
          git: { branch: "feature/shared", worktreeRoot: "R:\\two" },
        },
      ]),
    ).toContainEqual(expect.objectContaining({ kind: "SAME_BRANCH", count: 2 }));
  });
});

describe("Agent Session 聚合", () => {
  it("同项目同 Agent 只保留一行并优先在线 Session", () => {
    const result = summarizeAgentSessions([
      session("new-closed", "codex-root", "ATM", "CLOSED", "2026-08-08T12:00:00Z"),
      session("online", "codex-root", "ATM", "ONLINE", "2026-08-08T11:00:00Z"),
      session("old-closed", "codex-root", "ATM", "CLOSED", "2026-08-08T10:00:00Z"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "online", sessionCount: 3 });
    expect(result[0]?.sessionHistory.map((item) => item.id)).toEqual([
      "new-closed",
      "online",
      "old-closed",
    ]);
  });

  it("不同 Agent 或不同项目不会误合并，并按在线和最近活动排序", () => {
    const result = summarizeAgentSessions([
      session("atm-codex", "codex-root", "ATM", "CLOSED", "2026-08-08T10:00:00Z"),
      session("e2e-codex", "codex-root", "E2E", "ONLINE", "2026-08-08T09:00:00Z"),
      session("atm-claude", "claude-code", "ATM", "CLOSED", "2026-08-08T12:00:00Z"),
    ]);

    expect(result.map((item) => item.id)).toEqual(["e2e-codex", "atm-claude", "atm-codex"]);
    expect(result.every((item) => item.sessionCount === 1)).toBe(true);
  });

  it("按项目聚合 Agent 身份，同时保留每个身份的完整历史", () => {
    const result = groupAgentSessions([
      session("atm-old", "codex-root", "ATM", "CLOSED", "2026-08-08T10:00:00Z"),
      session("atm-online", "codex-root", "ATM", "ONLINE", "2026-08-08T12:00:00Z"),
      session("atm-review", "reviewer", "ATM", "CLOSED", "2026-08-08T11:00:00Z"),
      session("aot-online", "codex-root", "AOT", "ONLINE", "2026-08-08T09:00:00Z"),
    ]);

    expect(result.map((group) => group.project)).toEqual(["ATM", "AOT"]);
    expect(result[0]).toMatchObject({ project: "ATM", sessionCount: 3, onlineCount: 1 });
    expect(result[0]?.agents).toHaveLength(2);
    expect(result[0]?.agents.find((item) => item.agentId === "codex-root"))?.toMatchObject({
      id: "atm-online",
      sessionCount: 2,
    });
    expect(
      result[0]?.agents.find((item) => item.agentId === "codex-root")?.sessionHistory,
    ).toHaveLength(2);
  });
});
