import { describe, expect, it, vi } from "vitest";
import { AyanamiClient, AyanamiClientError } from "../src/index.js";

const task = (key: string) => ({
  key,
  status: "READY",
  phase: "READY",
  waitingOn: null,
  progress: 0,
  progressSource: "NONE",
  version: 1,
  updatedAt: "2026-08-28T00:00:00.000Z",
});

describe("Task client pagination", () => {
  it("exposes a page and keeps tasks.list compatible by draining every page", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const cursor = url.searchParams.get("cursor");
      const body = cursor
        ? cursor === "tl1.second.digest"
          ? { items: [task("CLI-T-0003")], nextCursor: null, hasMore: false }
          : { items: [task("CLI-T-0002")], nextCursor: "tl1.second.digest", hasMore: true }
        : { items: [task("CLI-T-0001")], nextCursor: "tl1.first.digest", hasMore: true };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const client = new AyanamiClient({ endpoint: "http://127.0.0.1:9999", token: "x", fetchImpl });

    await expect(client.tasks.page("CLI", { limit: 1, view: "core" })).resolves.toMatchObject({
      items: [expect.objectContaining({ key: "CLI-T-0001" })],
      nextCursor: "tl1.first.digest",
      hasMore: true,
    });
    await expect(client.tasks.list("CLI", { limit: 1, view: "core" })).resolves.toEqual([
      expect.objectContaining({ key: "CLI-T-0001" }),
      expect.objectContaining({ key: "CLI-T-0002" }),
      expect.objectContaining({ key: "CLI-T-0003" }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(String(fetchImpl.mock.calls[3]?.[0])).toContain("cursor=tl1.second.digest");
  });

  it("fails closed with a resumable cursor at the bounded drain limit", async () => {
    const client = new AyanamiClient({
      endpoint: "http://127.0.0.1:9999",
      token: "x",
      fetchImpl: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ items: [task("CLI-T-0001")], nextCursor: "tl1.next", hasMore: true }),
            { status: 200 },
          ),
      ),
    });
    await expect(
      client.tasks.list("CLI", { limit: 1 }, { maxPages: 1 }),
    ).rejects.toMatchObject<AyanamiClientError>({
      code: "INVALID_RESPONSE",
      details: { entity: "TASK_PAGE", reason: "DRAIN_LIMIT_REACHED", resumeCursor: "tl1.next" },
    });
  });
});
