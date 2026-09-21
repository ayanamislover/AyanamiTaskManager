import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { KnowledgeContentSchema } from "@ayanami-task/protocol";
import { connectProfiledClients } from "./profile-client.js";

it.each(["a", '\\"\n\t😀'])(
  "最大合法元数据可按固定修订完整续读，且编辑往返无丢失 %s",
  async (unit) => {
    const root = await mkdtemp(join(tmpdir(), "atm-metadata-pages-"));
    const service = await AyanamiTaskService.open({
      dataDir: root,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const clients = await connectProfiledClients(service, "metadata-pages");
    try {
      const long = (size: number) => unit.repeat(size).slice(0, size);
      const input = {
        slug: "max-meta",
        title: "最大元数据",
        summary: long(1000),
        useWhen: long(2000),
        tags: Array(30).fill(long(80)),
        aliases: Array(30).fill(long(160)),
        appliesTo: Array(30).fill(long(200)),
        sourceRefs: Array.from({ length: 30 }, () => ({
          type: "manual" as const,
          reference: long(2000),
        })),
        bodyMarkdown: "# 正文\n不能因来源过长而无法读取。",
      };
      const saved = await service.knowledge.save({
        ...input,
        opId: "max-create",
        expectedVersion: 0,
      });
      for (const forEdit of [false, true]) {
        const result = await clients.client.callTool({
          name: "atm_knowledge_get",
          arguments: { id: saved.id, for_edit: forEdit, max_chars: 2000 },
        });
        expect(result.isError).not.toBe(true);
        const first = result.structuredContent as Record<string, any>;
        expect(JSON.stringify(first).length).toBeLessThanOrEqual(2000);
        expect(first.metadataTruncated).toBe(true);
        expect(first.metadataRead).toEqual({
          id: saved.id,
          revision_id: saved.revisionId,
          part: "metadata",
        });
        let cursor: string | null = null;
        let metadataJson = "";
        let pages = 0;
        do {
          const response = await clients.client.callTool({
            name: "atm_knowledge_get",
            arguments: { ...first.metadataRead, max_chars: 5000, ...(cursor ? { cursor } : {}) },
          });
          expect(response.isError).not.toBe(true);
          const page = response.structuredContent as Record<string, any>;
          expect(JSON.stringify(page).length).toBeLessThanOrEqual(5000);
          expect(page.revisionId).toBe(saved.revisionId);
          expect(page.offset).toBe(metadataJson.length);
          metadataJson += page.metadataJson;
          expect(page.nextCursor).not.toBe(cursor === null ? "" : cursor);
          cursor = page.nextCursor;
          if (++pages > 200) throw Error("metadata cursor did not terminate");
        } while (cursor);
        const expected = KnowledgeContentSchema.omit({ bodyMarkdown: true }).parse(input);
        expect(JSON.parse(metadataJson)).toEqual(expected);
        const roundtrip = await service.knowledge.save({
          ...JSON.parse(metadataJson),
          slug: `roundtrip-${forEdit}`,
          bodyMarkdown: first.bodyMarkdown,
          opId: `roundtrip-${forEdit}`,
          expectedVersion: 0,
        });
        expect(KnowledgeContentSchema.parse(roundtrip)).toEqual({
          ...KnowledgeContentSchema.parse(input),
          slug: `roundtrip-${forEdit}`,
        });
      }
      const start = await clients.client.callTool({
        name: "atm_knowledge_get",
        arguments: { id: saved.id, part: "metadata", max_chars: 2000 },
      });
      const firstPage = start.structuredContent as Record<string, any>;
      const updated = await service.knowledge.save({
        ...input,
        opId: "max-update",
        id: saved.id,
        expectedVersion: 1,
        expectedRevisionId: saved.revisionId,
        summary: "new summary",
      });
      const continuation = await clients.client.callTool({
        name: "atm_knowledge_get",
        arguments: {
          id: saved.id,
          part: "metadata",
          cursor: firstPage.nextCursor,
          max_chars: 2000,
        },
      });
      expect(continuation.isError).not.toBe(true);
      expect(continuation.structuredContent).toMatchObject({
        revisionId: saved.revisionId,
        offset: firstPage.metadataJson.length,
      });
      for (const extra of [
        { part: "body" },
        { revision_id: updated.revisionId },
        { id: "wrong" },
        { section: "正文" },
      ]) {
        expect(
          (
            await clients.client.callTool({
              name: "atm_knowledge_get",
              arguments: { id: saved.id, part: "metadata", cursor: firstPage.nextCursor, ...extra },
            })
          ).isError,
        ).toBe(true);
      }
      expect(
        (
          await clients.client.callTool({
            name: "atm_knowledge_get",
            arguments: { id: saved.id, part: "metadata", max_chars: 1 },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await clients.close();
      service.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
