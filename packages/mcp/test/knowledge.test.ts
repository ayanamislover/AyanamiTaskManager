import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];
const services: AyanamiTaskService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function openService(): Promise<AyanamiTaskService> {
  const root = await mkdtemp(join(tmpdir(), "atm-mcp-knowledge-"));
  roots.push(root);
  const service = await AyanamiTaskService.open({
    dataDir: root,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  services.push(service);
  return service;
}

function content(index: number) {
  return {
    opId: `knowledge-entry-${index}`,
    expectedVersion: 0,
    slug: `mcp-knowledge-${index}`,
    title: `共享知识 ${index}`,
    summary: `用于 MCP 多页检索的 shared-term 摘要 ${index}`,
    useWhen: "验证跨项目约定时",
    tags: ["mcp", "shared"],
    appliesTo: ["ATM"],
    bodyMarkdown: `# 条目 ${index}\n\nshared-term 正文 ${index}`,
  };
}

describe("MCP 本地共享知识工具", () => {
  it("在无项目环境返回多页元数据，使用 snake_case 输入且不带正文", async () => {
    const service = await openService();
    expect(service.listProjects()).toEqual([]);
    for (let index = 0; index < 34; index += 1) {
      await service.knowledge.save(content(index));
    }

    const profiles = await connectProfiledClients(service, "mcp-knowledge-search");
    try {
      const ids: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const response = await profiles.client.callTool({
          name: "atm_knowledge_search",
          arguments: {
            query: "shared-term",
            include_archived: false,
            limit: 7,
            max_chars: 2400,
            ...(cursor === undefined ? {} : { cursor }),
          },
        });
        expect(response.isError).not.toBe(true);
        const body = response.structuredContent as {
          hits: Array<Record<string, unknown>>;
          hasMore: boolean;
          nextCursor: string | null;
        };
        expect(JSON.stringify(body).length).toBeLessThanOrEqual(2400);
        expect(body.hits.every((hit) => !Object.hasOwn(hit, "bodyMarkdown"))).toBe(true);
        expect(body.hits.every((hit) => Object.hasOwn(hit, "useWhen"))).toBe(true);
        ids.push(...body.hits.map((hit) => String(hit.id)));
        cursor = body.nextCursor ?? undefined;
        expect(body.hasMore).toBe(cursor !== undefined);
        if (++pages > 20) throw new Error("knowledge search cursor did not make progress");
      } while (cursor !== undefined);

      expect(pages).toBeGreaterThan(1);
      expect(new Set(ids).size).toBe(34);
    } finally {
      await profiles.close();
    }
  });

  it("正文续读固定不可变 revisionId，更新条目也不会串入新正文", async () => {
    const service = await openService();
    const firstBody = `# 第一版\n\n${"REVISION_ONE 内容😀 ".repeat(500)}\n## 末节\n结束。`;
    const entry = await service.knowledge.save({
      ...content(1),
      opId: "knowledge-revision-create",
      bodyMarkdown: firstBody,
    });
    const profiles = await connectProfiledClients(service, "mcp-knowledge-get");
    try {
      const firstResponse = await profiles.client.callTool({
        name: "atm_knowledge_get",
        arguments: { id: entry.id, max_chars: 1800 },
      });
      expect(firstResponse.isError).not.toBe(true);
      let page = firstResponse.structuredContent as {
        id: string;
        revision: number;
        revisionId: string;
        bodyMarkdown: string;
        nextCursor: string | null;
        truncated: boolean;
      };
      expect(page.id).toBe(entry.id);
      expect(page.revision).toBe(1);
      expect(page.revisionId).toEqual(expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/u));
      expect(page.truncated).toBe(true);
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(1800);

      const second = await service.knowledge.save({
        ...content(1),
        id: entry.id,
        opId: "knowledge-revision-update",
        expectedVersion: 1,
        expectedRevisionId: entry.revisionId,
        title: "第二版",
        bodyMarkdown: "# 第二版\n\nREVISION_TWO MUST NOT APPEAR IN REVISION_ONE CURSOR",
      });
      expect(second.revision).toBe(2);

      let collected = page.bodyMarkdown;
      let cursor = page.nextCursor;
      let pages = 1;
      while (cursor !== null) {
        const response = await profiles.client.callTool({
          name: "atm_knowledge_get",
          arguments: { id: entry.id, revision_id: page.revisionId, cursor, max_chars: 1800 },
        });
        expect(response.isError).not.toBe(true);
        page = response.structuredContent as typeof page;
        expect(JSON.stringify(page).length).toBeLessThanOrEqual(1800);
        expect(page.revision).toBe(1);
        expect(page.bodyMarkdown).not.toContain("REVISION_TWO");
        collected += page.bodyMarkdown;
        const next = page.nextCursor;
        expect(next).not.toBe(cursor);
        cursor = next;
        if (++pages > 100) throw new Error("knowledge get cursor did not make progress");
      }
      expect(collected).toBe(firstBody);

      const latest = await profiles.client.callTool({
        name: "atm_knowledge_get",
        arguments: { id: entry.id, max_chars: 1800 },
      });
      expect(latest.isError).not.toBe(true);
      expect(latest.structuredContent).toMatchObject({
        id: entry.id,
        revision: 2,
        bodyMarkdown: expect.stringContaining("REVISION_TWO"),
      });
    } finally {
      await profiles.close();
    }
  });
});
