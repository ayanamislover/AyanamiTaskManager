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

// ATM-T-0406：跨 Session 恢复时手里没有上次的 seq（它在被压缩掉的上下文里），
// 而从 atm_begin 给的当前 seq 往后取 delta 按定义是空的。省略 since_seq 取最新窗口。
describe("atm_delta 省略 since_seq", () => {
  it("返回最新 limit 条并换算出等价 since_seq，带 since_seq 的语义不变", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-delta-latest-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    cleanups.push(() => service.close());
    const project = await service.createProject({
      name: "增量窗口",
      sourcePath: null,
      code: "DLW",
    });
    const setup = await service.begin({
      projectCode: project.code,
      mode: "project",
      agentId: "delta-latest-setup",
      clientKind: "test",
      role: "SUBAGENT",
    });
    // 两种事件交替写入，types 过滤才有东西可滤。
    for (let index = 0; index < 12; index += 1) {
      await service.createRecordAsUser(project.code, `delta-latest-${index}`, {
        kind: "FACT",
        title: `事实 ${index}`,
        summary: `第 ${index} 条`,
      });
      await service.addProjectProgress(project.code, String(setup.session), `delta-p-${index}`, {
        summary: `进度 ${index}`,
        completed: [],
        next: [],
      });
    }
    const profiles = await connectProfiledClients(service, "delta-latest-window");
    cleanups.push(profiles.close);
    const delta = async (args: Record<string, unknown>) => {
      const response = await profiles.client.callTool({
        name: "atm_delta",
        arguments: { project: project.code, ...args },
      });
      if (response.isError) throw new Error(JSON.stringify(response.content));
      return response.structuredContent as Record<string, any>;
    };
    const seqs = (body: Record<string, any>) =>
      (body.events as Array<{ seq: number }>).map((event) => event.seq);

    const latest = await delta({ limit: 5 });
    expect(latest.window).toBe("latest");
    expect(seqs(latest)).toHaveLength(5);
    expect(seqs(latest)).toEqual([...seqs(latest)].sort((a, b) => a - b));
    expect(seqs(latest).at(-1)).toBe(latest.current_sequence);
    expect(latest.since_seq).toBe(seqs(latest)[0]! - 1);
    expect(latest.has_more).toBe(false);

    // 换算出的 since_seq 与显式传入等价，便于之后照常增量读取。
    const explicit = await delta({ limit: 5, since_seq: latest.since_seq });
    expect(explicit).not.toHaveProperty("window");
    expect(seqs(explicit)).toEqual(seqs(latest));

    // 原有语义：从 0 开始读的是最早的一批，并且还有更多。
    const oldest = await delta({ limit: 5, since_seq: 0 });
    expect(seqs(oldest)[0]).toBeLessThan(seqs(latest)[0]!);
    expect(oldest.has_more).toBe(true);

    // types 过滤作用在窗口之内：最新 3 条都属于被点名的类型。
    const recordEvents = (latest.events as Array<{ type: string }>).filter((event) =>
      event.type.startsWith("record"),
    );
    expect(recordEvents.length).toBeGreaterThan(0);
    expect(recordEvents.length).toBeLessThan(latest.events.length);
    const type = recordEvents.at(-1)!.type;
    const filtered = await delta({ limit: 3, types: [type] });
    expect(filtered.events.map((event: { type: string }) => event.type)).toEqual([
      type,
      type,
      type,
    ]);
    expect(filtered.window).toBe("latest");

    // 预算收紧时 window 标签也算在 max_chars 里。
    // 连扫一段预算：余量总有小于标签长度的时候，单点取值可能恰好放得下而空转。
    const eventChars = JSON.stringify(latest.events[0]).length;
    for (let maxChars = 1000; maxChars <= 1000 + eventChars + 50; maxChars += 1) {
      const tight = await delta({ limit: 20, max_chars: maxChars });
      expect(JSON.stringify(tight).length).toBeLessThanOrEqual(maxChars);
      expect(tight.window).toBe("latest");
    }
  });
});
