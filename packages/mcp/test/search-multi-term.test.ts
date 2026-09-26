import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { MAX_SEARCH_TERMS } from "../../storage-sqlite/src/search-terms.js";
import { createAtmSearchTool } from "../src/tools/memory/search.js";
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

async function open() {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-search-terms-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  services.push(service);
  const profiles = await connectProfiledClients(service, "search-multi-term-test");
  connections.push(profiles.close);
  return { service, client: profiles.client };
}

type Client = Awaited<ReturnType<typeof open>>["client"];

async function search(client: Client, args: Record<string, unknown>) {
  const response = await client.callTool({
    name: "atm_search",
    arguments: { max_chars: 20_000, ...args },
  });
  expect(response.isError).not.toBe(true);
  return response.structuredContent as Record<string, any>;
}

const keys = (body: Record<string, any>) =>
  (body.hits as Array<Record<string, unknown>>).map((hit) => String(hit.entity_key));

// ATM-T-0408：`D-398 HALF_OPEN 复审裁决` 这类「ID 片段 + 关键词」曾被当成一个
// 相邻短语匹配而 0 命中；key 本身在 FTS 里不建索引，单打 ID 片段也搜不到。
describe("atm_search 多词查询", () => {
  it("每个词各自匹配后取交集，ID 片段按 entity_key 命中", async () => {
    const { service, client } = await open();
    const project = await service.createProject({
      name: "多词搜索",
      sourcePath: null,
      code: "MTS",
    });
    const target = await service.createRecordAsUser(project.code, "target", {
      kind: "DECISION",
      title: "熔断器 HALF_OPEN 复审",
      summary: "复审裁决：保持 HALF_OPEN 探测窗口。",
    });
    const decoy = await service.createRecordAsUser(project.code, "decoy", {
      kind: "FACT",
      title: "HALF_OPEN 状态说明",
      summary: "只描述状态本身。",
    });
    const targetKey = String(target.key);
    const idFragment = targetKey.slice(project.code.length + 1);
    expect(idFragment).toMatch(/^[A-Z]-\d+$/u);

    const natural = `${idFragment} HALF_OPEN 复审裁决`;
    expect(keys(await search(client, { project: project.code, query: natural }))).toEqual([
      targetKey,
    ]);

    const global = await search(client, { query: natural });
    expect(keys(global)).toEqual([targetKey]);
    expect(global.hits[0].project).toBe(project.code);

    // 临时任务在全局搜索里走同一套拆词，Q- 编号也能当 ID 片段查。
    service.createQuickTask({ title: "HALF_OPEN 临时排查", note: "复审前先看日志", actor: "user" });
    const quick = await search(client, { query: "HALF_OPEN 日志" });
    expect(quick.hits.map((hit: Record<string, unknown>) => hit.entity_type)).toEqual([
      "QUICK_TASK",
    ]);
    expect(keys(await search(client, { query: `${quick.hits[0].entity_key} 排查` }))).toEqual([
      quick.hits[0].entity_key,
    ]);

    // 少于三个 code point 的词走 LIKE，同样参与交集。
    expect(keys(await search(client, { project: project.code, query: "熔断 HALF_OPEN" }))).toEqual([
      targetKey,
    ]);
    expect(keys(await search(client, { project: project.code, query: idFragment }))).toEqual([
      targetKey,
    ]);
    // 完整 key 夹在关键词里时同样命中，不要求单独打 key。
    expect(
      keys(await search(client, { query: `${targetKey} HALF_OPEN`, project: project.code })),
    ).toEqual([targetKey]);
    // 双引号仍表示相邻短语：正文里 HALF_OPEN 与「探测」相邻，与「复审」不相邻。
    expect(
      keys(await search(client, { project: project.code, query: '"HALF_OPEN 探测"' })),
    ).toEqual([targetKey]);
    expect(
      keys(await search(client, { project: project.code, query: '"HALF_OPEN 复审裁决"' })),
    ).toEqual([]);
    // 单个共同词两条都在，确认交集不是把 decoy 一律排除。
    expect(
      new Set(keys(await search(client, { project: project.code, query: "HALF_OPEN" }))),
    ).toEqual(new Set([targetKey, String(decoy.key)]));
  });

  it("0 命中时给出可操作的下一步", async () => {
    const { service, client } = await open();
    const project = await service.createProject({ name: "零命中", sourcePath: null, code: "MTZ" });
    await service.createRecordAsUser(project.code, "only", {
      kind: "FACT",
      title: "HALF_OPEN 状态说明",
      summary: "只描述状态本身。",
    });

    const multi = await search(client, { project: project.code, query: "HALF_OPEN 不存在的词" });
    expect(multi.hits).toEqual([]);
    expect(multi.next_step.reason).toBe("NO_MATCH");
    expect(multi.next_step.suggestions.join("\n")).toContain("删掉部分词");
    expect(multi.next_step.suggestions.join("\n")).toContain("省略 project");

    const single = await search(client, { query: "不存在的词" });
    expect(single.next_step.reason).toBe("NO_MATCH");
    expect(single.next_step.suggestions.join("\n")).not.toContain("省略 project");

    const hit = await search(client, { project: project.code, query: "HALF_OPEN" });
    expect(hit).not.toHaveProperty("next_step");

    // 最长的提示（多词 + 带 project）在 max_chars 下限里也放得下，不会让空结果报 RESULT_TOO_LARGE。
    const tight = await search(client, {
      project: project.code,
      query: "HALF_OPEN 不存在的词",
      limit: 30,
      max_chars: 300,
    });
    expect(JSON.stringify(tight).length).toBeLessThanOrEqual(300);
    expect(tight.next_step.suggestions).toHaveLength(3);
  });

  // ATM-T-0490 P2：原来第九个词起被静默丢掉，缺了 MUST_MATCH 的文档也会被当成命中返回。
  it("超过 8 个词时三条搜索路径都明确拒绝，不截断", async () => {
    const { service, client } = await open();
    const project = await service.createProject({
      name: "词数上限",
      sourcePath: null,
      code: "MTL",
    });
    const eight = "one two three four five six seven eight";
    await service.createRecordAsUser(project.code, "all-but-last", {
      kind: "FACT",
      title: eight,
      summary: "缺第九个词",
    });
    await service.knowledge.save({
      expectedVersion: 0,
      opId: "k-eight",
      slug: "eight-words",
      title: eight,
      summary: "缺第九个词",
      bodyMarkdown: eight,
      useWhen: "验证词数上限时",
      tags: ["search"],
      appliesTo: ["ATM"],
    });
    const nine = `${eight} MUST_MATCH`;
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { max_chars: 20_000, ...args } });
    const errorText = (response: Awaited<ReturnType<typeof call>>) => {
      expect(response.isError).toBe(true);
      return (response.content as Array<{ text?: string }>)[0]?.text ?? "";
    };

    for (const [label, response] of [
      ["项目", await call("atm_search", { project: project.code, query: nine })],
      ["全局", await call("atm_search", { query: nine })],
      ["知识", await call("atm_knowledge_search", { query: nine })],
    ] as const) {
      const text = errorText(response);
      expect(text, label).toContain("VALIDATION_ERROR");
      expect(text, label).toContain("最多 8 个词（去重后 9 个）");
    }

    // 恰好 8 个词照常搜；重复词去重后不算超限；用引号合并成短语也能表达更长的条件。
    expect(keys(await search(client, { project: project.code, query: eight }))).toHaveLength(1);
    expect(
      keys(await search(client, { project: project.code, query: `${eight} one two` })),
    ).toHaveLength(1);
    expect(
      keys(
        await search(client, {
          project: project.code,
          query: `"one two three" four five six seven eight MUST_MATCH`,
        }),
      ),
    ).toEqual([]);
  });

  it("公开说明写清了 8 个词的上限", async () => {
    const { service } = await open();
    expect(createAtmSearchTool(service).description).toContain(`最多 ${MAX_SEARCH_TERMS} 个`);
    const guide = readFileSync(join(process.cwd(), "ATM_AGENT_GUIDE.md"), "utf8");
    expect(guide).toMatch(/`atm_search`[^\n]*最多 8 个词，超出直接报错/u);
  });

  it("atm_knowledge_search 同样按词取交集", async () => {
    const { service, client } = await open();
    const base = {
      expectedVersion: 0,
      useWhen: "验证多词搜索时",
      tags: ["search"],
      appliesTo: ["ATM"],
    };
    await service.knowledge.save({
      ...base,
      opId: "k-target",
      slug: "breaker-review",
      title: "熔断复审约定",
      summary: "复审流程",
      bodyMarkdown: "# 约定\n\nHALF_OPEN 窗口由复审裁决。",
    });
    await service.knowledge.save({
      ...base,
      opId: "k-decoy",
      slug: "breaker-states",
      title: "熔断状态表",
      summary: "状态说明",
      bodyMarkdown: "# 状态\n\nHALF_OPEN 表示探测中。",
    });
    const titles = async (query: string) => {
      const response = await client.callTool({
        name: "atm_knowledge_search",
        arguments: { query, max_chars: 20_000 },
      });
      expect(response.isError).not.toBe(true);
      const body = response.structuredContent as { hits: Array<{ title: string }> };
      return body.hits.map((hit) => hit.title).sort();
    };
    expect(await titles("HALF_OPEN 裁决")).toEqual(["熔断复审约定"]);
    expect(await titles("熔断复审 HALF_OPEN")).toEqual(["熔断复审约定"]);
    expect(await titles("HALF_OPEN")).toEqual(["熔断复审约定", "熔断状态表"]);
  });
});
