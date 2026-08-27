import { describe, expect, it } from "vitest";
import { SessionPageSchema, SessionViewSchema } from "../src/index.js";

const session = {
  id: "01K00000000000000000000000",
  agentId: "codex",
  displayName: "Codex",
  clientKind: "codex",
  capabilities: [],
  parentSessionId: null,
  predecessorSessionId: null,
  threadId: null,
  role: "SUBAGENT",
  cwd: null,
  workState: "PLANNING",
  connectionState: "ONLINE",
  currentTaskKey: null,
  heartbeatAt: null,
  lastSeenAt: "2026-08-28T00:00:00.000Z",
  version: 0,
  startedAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
  closedAt: null,
  retirementReason: null,
  closeReason: null,
  git: {
    available: false,
    repoRoot: null,
    worktreeRoot: null,
    commonDir: null,
    isLinkedWorktree: null,
    branch: null,
    head: null,
    detached: null,
    dirty: null,
    error: null,
  },
} as const;

describe("Session view contract", () => {
  it("accepts canonical camelCase view and page only", () => {
    expect(SessionViewSchema.parse(session)).toEqual(session);
    expect(SessionPageSchema.parse({ items: [session], nextCursor: null, hasMore: false })).toEqual(
      {
        items: [session],
        nextCursor: null,
        hasMore: false,
      },
    );
    expect(() =>
      SessionViewSchema.parse({ ...session, last_seen_at: session.lastSeenAt }),
    ).toThrow();
  });
});
