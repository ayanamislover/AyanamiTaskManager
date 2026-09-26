import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

function body(result: { isError?: unknown; content: unknown; structuredContent?: unknown }) {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as Record<string, any>;
}

// ATM-T-0405：压缩后按规矩调 atm_begin，默认预算下拿回的却是八个分节全省、
// records 返回 0 条、continuation_omitted: true——游标本身（v2 约 560 字符）就放不下。
// ADR-014 把恢复 brief 的默认预算定在 1200，这里钉住：在这个默认值下，
// 最坏规模的 Record 集合也必须留下可续读的游标，并能沿游标无损取回全部 Record。
describe("默认预算下的恢复 brief", () => {
  it("atm_begin 与 atm_brief 不传 max_chars 时保住 continuation，续读取回全部 Record", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-brief-default-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    cleanups.push(() => service.close());
    const project = await service.createProject({
      name: "默认预算",
      sourcePath: null,
      code: "BRIEFDEF",
    });
    const setup = await service.begin({
      projectCode: project.code,
      mode: "project",
      agentId: "brief-default-setup",
      clientKind: "test",
      role: "SUBAGENT",
    });
    const expected: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const record = await service.createRecord(
        project.code,
        String(setup.session),
        `brief-default-${index}`,
        {
          kind: "RISK",
          title: `风险 ${index}`,
          // summary 上限 300 个 code point：取满，是 brief 里单条 Record 的最坏情况。
          summary: `${index}:${"熔".repeat(298)}`,
          importance: "CRITICAL",
          sourceActorId: `codex-peer-reviewer-with-a-long-actor-id-${index}`,
          sourceRef: `https://example.invalid/review/${index}`,
        },
      );
      expected.unshift(record.key);
    }
    const profiles = await connectProfiledClients(service, "brief-default-budget");
    cleanups.push(profiles.close);

    const begun = body(
      await profiles.coreClient.callTool({
        name: "atm_begin",
        arguments: {
          project_code: project.code,
          mode: "project",
          agent_id: "brief-default-reader",
          role: "OBSERVER",
          op_id: `begin-${"x".repeat(122)}`,
        },
      }),
    );
    expect(JSON.stringify(begun).length).toBeLessThanOrEqual(1200);
    expect(begun).not.toHaveProperty("continuation_omitted");
    expect(begun.continuation).toMatchObject({ tool: "atm_brief", cursor: expect.any(String) });
    // 预算先让给无法续读的分节：Record 丢了能沿游标取回，这几项丢了就没了。
    expect(begun.omitted_sections ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(own|counts|objective|next)$/u)]),
    );
    expect(begun).toHaveProperty("next");
    expect(begun).toHaveProperty("active");
    // brief 里的 Record 只留恢复工作要用的字段，来源细节按 key 走 atm_search。
    for (const record of begun.records ?? []) {
      expect(Object.keys(record).sort()).toEqual(
        ["importance", "key", "kind", "source_type", "summary"].sort(),
      );
    }

    const restored: string[] = (begun.records ?? []).map((record: { key: string }) => record.key);
    let cursor: string | undefined = begun.continuation.cursor;
    for (let page = 0; cursor && page < 10; page += 1) {
      const next = body(
        await profiles.coreClient.callTool({
          name: "atm_brief",
          arguments: { project_code: project.code, session_id: begun.session, cursor },
        }),
      );
      expect(JSON.stringify(next).length).toBeLessThanOrEqual(1200);
      expect(next.records.length).toBeGreaterThan(0);
      for (const record of next.records) {
        expect(record).not.toHaveProperty("source_actor_id");
        expect(record.summary).toBe(`${record.summary.split(":")[0]}:${"熔".repeat(298)}`);
      }
      restored.push(...next.records.map((record: { key: string }) => record.key));
      cursor = next.continuation?.cursor;
    }
    expect(restored).toEqual(expected);

    // atm_brief 首页同样不能退化成 continuation_omitted。
    const brief = body(
      await profiles.coreClient.callTool({
        name: "atm_brief",
        arguments: { project_code: project.code, session_id: begun.session },
      }),
    );
    expect(JSON.stringify(brief).length).toBeLessThanOrEqual(1200);
    expect(brief).not.toHaveProperty("continuation_omitted");
    expect(brief.continuation.cursor).toEqual(expect.any(String));
  });
});
