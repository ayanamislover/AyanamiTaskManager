import { describe, expect, it, vi } from "vitest";
import { AyanamiClient, AyanamiClientError } from "../src/index.js";

const record = (key: string) => ({
  id: key,
  key,
  kind: "FACT",
  title: key,
  summary: key,
  detail: "",
  importance: "NORMAL",
  scope: "PROJECT",
  workItemKey: null,
  supersedes: null,
  status: "ACTIVE",
  topic: null,
  subjectKey: null,
  relatedRecords: [],
  opId: null,
  sourceType: "AGENT",
  sourceActorId: "agent",
  sourceSessionId: "session",
  sourceRef: null,
  createdAt: "2026-08-27T20:00:00.000Z",
  updatedAt: "2026-08-27T20:00:00.000Z",
});

describe("Record client pagination", () => {
  it("exposes one page and keeps records() compatible by draining every page", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const cursor = url.searchParams.get("cursor");
      const body = cursor
        ? { items: [record("CLI-R-001")], nextCursor: null, hasMore: false }
        : { items: [record("CLI-R-002")], nextCursor: "rl1.next.digest", hasMore: true };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new AyanamiClient({ endpoint: "http://127.0.0.1:9999", token: "x", fetchImpl });

    await expect(client.projects.recordPage("CLI", 10)).resolves.toMatchObject({
      items: [expect.objectContaining({ key: "CLI-R-002" })],
      hasMore: true,
    });
    await expect(client.projects.records("CLI")).resolves.toEqual([
      expect.objectContaining({ key: "CLI-R-002" }),
      expect.objectContaining({ key: "CLI-R-001" }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain("cursor=rl1.next.digest");
  });

  it("fails closed when hasMore omits nextCursor", async () => {
    const client = new AyanamiClient({
      endpoint: "http://127.0.0.1:9999",
      token: "x",
      fetchImpl: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ items: [record("CLI-R-002")], nextCursor: null, hasMore: true }),
            { status: 200 },
          ),
      ),
    });
    await expect(client.projects.records("CLI")).rejects.toMatchObject<AyanamiClientError>({
      code: "INVALID_RESPONSE",
      status: 502,
      details: { reason: "MISSING_NEXT_CURSOR" },
    });
  });

  it("fails closed instead of looping on a repeated nextCursor", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            items: [record("CLI-R-002")],
            nextCursor: "rl1.same.digest",
            hasMore: true,
          }),
          { status: 200 },
        ),
    );
    const client = new AyanamiClient({
      endpoint: "http://127.0.0.1:9999",
      token: "x",
      fetchImpl,
    });
    await expect(client.projects.records("CLI")).rejects.toMatchObject<AyanamiClientError>({
      code: "INVALID_RESPONSE",
      status: 502,
      details: { reason: "REPEATED_CURSOR" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
