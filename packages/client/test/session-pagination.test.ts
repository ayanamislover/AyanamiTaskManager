import { describe, expect, it, vi } from "vitest";
import { AyanamiClient, AyanamiClientError } from "../src/index.js";

const session = (id: string) => ({
  id,
  agentId: "agent",
  displayName: "Agent",
  clientKind: "test",
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
});

describe("Session client pagination", () => {
  it("exposes one page and drains agents() across every page", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const cursor = url.searchParams.get("cursor");
      const body = cursor
        ? { items: [session("session-1")], nextCursor: null, hasMore: false }
        : { items: [session("session-2")], nextCursor: "sl1.next.digest", hasMore: true };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const client = new AyanamiClient({ endpoint: "http://127.0.0.1:9999", token: "x", fetchImpl });

    await expect(client.projects.agentPage("CLI", 10)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "session-2" })],
      hasMore: true,
    });
    await expect(client.projects.agents("CLI")).resolves.toEqual([
      expect.objectContaining({ id: "session-2" }),
      expect.objectContaining({ id: "session-1" }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain("cursor=sl1.next.digest");
  });

  it("fails closed when hasMore omits or repeats nextCursor", async () => {
    const missing = new AyanamiClient({
      endpoint: "http://127.0.0.1:9999",
      token: "x",
      fetchImpl: vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: true })),
      ),
    });
    await expect(missing.projects.agents("CLI")).rejects.toMatchObject<AyanamiClientError>({
      code: "INVALID_RESPONSE",
      status: 502,
      details: { reason: "MISSING_NEXT_CURSOR" },
    });

    const repeatedFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            items: [session("session-1")],
            nextCursor: "sl1.same.digest",
            hasMore: true,
          }),
        ),
    );
    const repeated = new AyanamiClient({
      endpoint: "http://127.0.0.1:9999",
      token: "x",
      fetchImpl: repeatedFetch,
    });
    await expect(repeated.projects.agents("CLI")).rejects.toMatchObject<AyanamiClientError>({
      code: "INVALID_RESPONSE",
      status: 502,
      details: { reason: "REPEATED_CURSOR" },
    });
    expect(repeatedFetch).toHaveBeenCalledTimes(2);
  });
});
