import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];
const services: AyanamiTaskService[] = [];
const connections: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of connections.splice(0)) await close();
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

describe("atm_search keyset pagination", () => {
  it("returns all 61 original hits in 20/20/20/1 pages without admitting a later insert", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-search-pages-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    services.push(service);
    const project = await service.createProject({
      name: "搜索分页",
      sourcePath: null,
      code: "SPAGE",
    });
    const profiles = await connectProfiledClients(service, "search-pages-test");
    connections.push(profiles.close);

    const expected = new Set<string>();
    for (let index = 0; index < 61; index += 1) {
      const created = await service.createRecordAsUser(project.code, `seed-${index}`, {
        kind: "FACT",
        title: `分页关键字记录 ${String(index).padStart(2, "0")}`,
        summary: "分页关键字必须无遗漏返回。",
      });
      expected.add(String(created.key));
    }

    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const response = await profiles.client.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query: "分页关键字",
          limit: 20,
          max_chars: 50_000,
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      expect(response.isError).not.toBe(true);
      const body = response.structuredContent as Record<string, any>;
      const hits = (body.hits as Array<Record<string, unknown>>).map((hit) =>
        String(hit.entity_key),
      );
      pages.push(hits);
      cursor = typeof body.next_cursor === "string" ? body.next_cursor : undefined;

      if (pageIndex === 0) {
        await service.createRecordAsUser(project.code, "later-insert", {
          kind: "FACT",
          title: "分页关键字稍后插入",
          summary: "该记录比第一页更新，不应插入旧 cursor 后续页。",
        });
      }
    }

    expect(pages.map((page) => page.length)).toEqual([20, 20, 20, 1]);
    const flattened = pages.flat();
    expect(new Set(flattened).size).toBe(61);
    expect(new Set(flattened)).toEqual(expected);
    expect(cursor).toBeUndefined();
  }, 30_000);

  it("advances the cursor by the hits actually returned under max_chars", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-search-budget-pages-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    services.push(service);
    const project = await service.createProject({
      name: "搜索预算分页",
      sourcePath: null,
      code: "SBUD",
    });
    const profiles = await connectProfiledClients(service, "search-budget-pages-test");
    connections.push(profiles.close);

    const expected = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
      const created = await service.createRecordAsUser(project.code, `budget-seed-${index}`, {
        kind: "FACT",
        title: `预算分页关键字 ${"长标题".repeat(60)} ${String(index).padStart(2, "0")}`,
        summary: "低预算分页必须按实际返回命中推进游标。",
      });
      expected.add(String(created.key));
    }

    const received: string[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const response = await profiles.client.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query: "预算分页关键字",
          limit: 10,
          max_chars: 1000,
          field_mask: ["entity_key", "title"],
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      expect(response.isError).not.toBe(true);
      const body = response.structuredContent as Record<string, any>;
      expect(JSON.stringify(body).length).toBeLessThanOrEqual(1000);
      expect(body.returned_count).toBe(body.hits.length);
      expect(body.returned_count).toBeGreaterThan(0);
      received.push(
        ...(body.hits as Array<Record<string, unknown>>).map((hit) => String(hit.entity_key)),
      );
      const next = typeof body.next_cursor === "string" ? body.next_cursor : undefined;
      if (!next) break;
      expect(next).not.toBe(cursor);
      cursor = next;
    }

    expect(received).toHaveLength(12);
    expect(new Set(received)).toEqual(expected);
  }, 30_000);

  it("rejects tampered, cross-query and cross-project cursors", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-search-cursor-binding-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    services.push(service);
    const first = await service.createProject({ name: "游标甲", sourcePath: null, code: "SCUA" });
    const second = await service.createProject({ name: "游标乙", sourcePath: null, code: "SCUB" });
    const profiles = await connectProfiledClients(service, "search-cursor-binding-test");
    connections.push(profiles.close);
    for (let index = 0; index < 3; index += 1) {
      await service.createRecordAsUser(first.code, `cursor-seed-${index}`, {
        kind: "FACT",
        title: `游标绑定关键字 ${index}`,
        summary: "游标不能跨查询或跨项目复用。",
      });
    }
    const page = await profiles.client.callTool({
      name: "atm_search",
      arguments: { project: first.code, query: "游标绑定关键字", limit: 1 },
    });
    const cursor = String((page.structuredContent as Record<string, unknown>).next_cursor);
    expect(cursor).toMatch(/^s1\./u);

    const constrained = await profiles.client.callTool({
      name: "atm_search",
      arguments: {
        project: first.code,
        query: "游标绑定关键字",
        limit: 2,
        cursor,
        max_chars: 300,
      },
    });
    expect(constrained.isError).not.toBe(true);
    expect(JSON.stringify(constrained.structuredContent).length).toBeLessThanOrEqual(300);
    const constrainedBody = constrained.structuredContent as Record<string, any>;
    if (constrainedBody.returned_count === 0) {
      expect(constrainedBody.next_cursor).toBe(cursor);
    }

    for (const arguments_ of [
      { project: first.code, query: "另一个关键字", limit: 1, cursor },
      { project: second.code, query: "游标绑定关键字", limit: 1, cursor },
      {
        project: first.code,
        query: "游标绑定关键字",
        limit: 1,
        cursor: `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`,
      },
    ]) {
      const response = await profiles.client.callTool({
        name: "atm_search",
        arguments: arguments_,
      });
      expect(response.isError).toBe(true);
      expect(String((response.content[0] as { text?: unknown }).text)).toContain("INVALID_CURSOR");
    }
  });
});
