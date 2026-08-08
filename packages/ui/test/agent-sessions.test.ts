import { describe, expect, it } from "vitest";
import { summarizeAgentSessions } from "../src/agent-sessions.js";

const session = (
  id: string,
  agentId: string,
  project: string,
  state: "ONLINE" | "CLOSED",
  lastSeenAt: string,
) => ({
  id,
  agent_id: agentId,
  display_name: agentId,
  project,
  role: "PRIMARY",
  connection_state: state,
  last_seen_at: lastSeenAt,
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
});
