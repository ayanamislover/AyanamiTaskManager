import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";

// resume:true 不带 predecessor 时原来是静默新建：条件 `resume && predecessorSessionId`
// 不成立就直接往下走，调用方看不出区别。而上下文压缩之后 predecessorSessionId 恰恰是
// agent 丢掉的那个东西，于是一段连续工作散成好几条 Session。
//
// 现在改成按 (agent_id, cwd, thread_id) 三项全等去接回自己那条还开着的 Session，
// 候选多于一条就 fail closed。这里逐条钉住「什么时候接回、什么时候不接」。

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 8 });
});

async function fixture(code: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-resume-fallback-"));
  temporary.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: "Resume", sourcePath: null, code });
  const managed = await manager.openProject(project.code);
  return { repository: new ProjectRepository(managed), managed };
}

const base = {
  agentId: "resume-agent",
  displayName: "Resume Agent",
  clientKind: "test",
  role: "PRIMARY" as const,
  cwd: "R:/repo",
  threadId: "thread-1",
};

function sessionCount(managed: { sqlite: { prepare: (sql: string) => { get: () => unknown } } }) {
  return (managed.sqlite.prepare("SELECT count(*) AS n FROM agent_sessions").get() as { n: number })
    .n;
}

describe("resume 不带 predecessor 时的接回", () => {
  it("同一身份且会话还开着时接回原 Session，不新建", async () => {
    const { repository, managed } = await fixture("RSA");
    const first = repository.createSession(base);
    const resumed = repository.createSession({ ...base, resume: true });

    expect(resumed.id).toBe(first.id);
    // 阳性对照：真的没有多出一条，而不是「返回了同一个 id 但也建了一条」。
    expect(sessionCount(managed)).toBe(1);
    // 接回要留痕，否则事后看不出这条 Session 被谁续过。
    expect(
      (
        managed.sqlite
          .prepare("SELECT count(*) AS n FROM events WHERE type = 'agent.resumed'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it("cwd 或 thread_id 不同就不接回，另建一条", async () => {
    const { repository, managed } = await fixture("RSB");
    repository.createSession(base);

    const otherCwd = repository.createSession({ ...base, resume: true, cwd: "R:/another" });
    const otherThread = repository.createSession({ ...base, resume: true, threadId: "thread-2" });

    expect(new Set([otherCwd.id, otherThread.id]).size).toBe(2);
    expect(sessionCount(managed)).toBe(3);
  });

  it("同一身份存在多条未关闭会话时 fail closed，不猜接哪一条", async () => {
    const { repository, managed } = await fixture("RSC");
    // 两条身份完全相同、都还开着：这正是同一个 agent_id 并发开会话的形状。
    repository.createSession(base);
    repository.createSession(base);

    expect(() => repository.createSession({ ...base, resume: true })).toThrowError(
      expect.objectContaining({ code: "SESSION_SUCCESSOR_AMBIGUOUS" }),
    );
    expect(sessionCount(managed)).toBe(2);
  });

  it("上一条已关闭时照旧新建", async () => {
    const { repository, managed } = await fixture("RSD");
    const first = repository.createSession(base);
    repository.endSession({ type: "AGENT", id: base.agentId, sessionId: first.id }, "end-first", {
      outcome: "COMPLETED",
      summary: "收工",
      releaseClaims: true,
    });

    const next = repository.createSession({ ...base, resume: true });
    expect(next.id).not.toBe(first.id);
    expect(sessionCount(managed)).toBe(2);
  });

  it("不传 resume 时永远新建，接回只挂在 resume 上", async () => {
    const { repository, managed } = await fixture("RSE");
    const first = repository.createSession(base);
    const second = repository.createSession(base);

    expect(second.id).not.toBe(first.id);
    expect(sessionCount(managed)).toBe(2);
  });
});
