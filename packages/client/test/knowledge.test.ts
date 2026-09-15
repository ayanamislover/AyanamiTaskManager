import { describe, expect, it, vi } from "vitest";
import { AyanamiClient } from "../src/index.js";

describe("Knowledge client surface", () => {
  it("uses the REST knowledge routes and exposes the knowledge backup helper", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({
        method: String(init?.method),
        url: String(input),
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      });
      return new Response(JSON.stringify({ id: "k-1", version: 1, revision: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new AyanamiClient({
      endpoint: "http://127.0.0.1:4393",
      token: "token",
      fetchImpl,
    });

    await client.knowledge.search({ query: "SQLite", tag: "windows", includeArchived: false });
    await client.knowledge.get("k/1", {
      revisionId: "01J00000000000000000000002",
      section: "h-1",
      maxChars: 6000,
    });
    await client.knowledge.history("k/1", 3, 10);
    await client.knowledge.save({
      opId: "save",
      expectedVersion: 0,
      slug: "sqlite",
      title: "SQLite",
      summary: "summary",
      bodyMarkdown: "body",
    });
    await client.knowledge.update("k/1", {
      opId: "update",
      expectedVersion: 1,
      expectedRevisionId: "01J00000000000000000000001",
      slug: "sqlite",
      title: "SQLite",
      summary: "summary",
      bodyMarkdown: "body 2",
    });
    await client.knowledge.archive({
      id: "k/1",
      opId: "archive",
      expectedVersion: 2,
      expectedRevisionId: "01J00000000000000000000002",
      archived: true,
    });
    await client.knowledge.previewRecord("SRC", "SRC-R-001");
    await client.backups.createKnowledge();

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://127.0.0.1:4393/api/v1/knowledge?query=SQLite&tag=windows&includeArchived=false",
      "GET http://127.0.0.1:4393/api/v1/knowledge/k%2F1?revisionId=01J00000000000000000000002&section=h-1&maxChars=6000",
      "GET http://127.0.0.1:4393/api/v1/knowledge/k%2F1/history?beforeRevision=3&limit=10",
      "POST http://127.0.0.1:4393/api/v1/knowledge",
      "PATCH http://127.0.0.1:4393/api/v1/knowledge/k%2F1",
      "POST http://127.0.0.1:4393/api/v1/knowledge/k%2F1/archive",
      "GET http://127.0.0.1:4393/api/v1/knowledge/preview-record?project=SRC&record=SRC-R-001",
      "POST http://127.0.0.1:4393/api/v1/backups",
    ]);
    expect(calls[5]?.body).toMatchObject({ id: "k/1", archived: true });
    expect(calls[7]?.body).toEqual({ scope: "KNOWLEDGE" });
  });
});
