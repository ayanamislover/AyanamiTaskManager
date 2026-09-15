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

type Managed = {
  sqlite: {
    prepare: (sql: string) => {
      get: (...a: unknown[]) => unknown;
      all: (...a: unknown[]) => unknown[];
    };
  };
};

function sessionCount(managed: Managed) {
  return (managed.sqlite.prepare("SELECT count(*) AS n FROM agent_sessions").get() as { n: number })
    .n;
}

function storedRole(managed: Managed, id: string) {
  return (
    managed.sqlite.prepare("SELECT role FROM agent_sessions WHERE id = ?").get(id) as {
      role: string;
    }
  ).role;
}

function connectionState(managed: Managed, id: string) {
  return (
    managed.sqlite
      .prepare("SELECT connection_state AS s FROM agent_sessions WHERE id = ?")
      .get(id) as {
      s: string;
    }
  ).s;
}

function resumedEvents(managed: Managed): Array<Record<string, unknown>> {
  return (
    managed.sqlite
      .prepare("SELECT payload_json FROM events WHERE type = 'agent.resumed' ORDER BY id")
      .all() as Array<{ payload_json: string }>
  ).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
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

  // ATM-T-0353：role 也算身份。少了它会出现「回执说接回成功、事件里记着 REVIEWER，
  // 而返回的那条 Session 实际还是 PRIMARY」，随后 submitReview 报 REVIEWER_REQUIRED，
  // 调用方对着一条自称 REVIEWER 的会话查不出原因。
  it("请求角色与在线会话不同就不接回，另起一条；事件里的 role 与库里一致", async () => {
    const { repository, managed } = await fixture("RSF");
    const primary = repository.createSession(base);

    const reviewer = repository.createSession({ ...base, resume: true, role: "REVIEWER" });
    expect(reviewer.id).not.toBe(primary.id);
    expect(storedRole(managed, reviewer.id)).toBe("REVIEWER");
    expect(storedRole(managed, primary.id)).toBe("PRIMARY");
    // 角色不同走的是新建，不该留下接回痕迹。
    expect(resumedEvents(managed)).toHaveLength(0);

    // 同角色才接回，且事件记的 role 必须等于库里那条 Session 的真实角色。
    const resumed = repository.createSession({ ...base, resume: true, role: "REVIEWER" });
    expect(resumed.id).toBe(reviewer.id);
    const events = resumedEvents(managed);
    expect(events).toHaveLength(1);
    expect(events[0]!.role).toBe(storedRole(managed, reviewer.id));
  });

  // ATM-T-0354：歧义提示必须是可执行的。原来它让调用方传 predecessor，可一传就撞
  // SESSION_NOT_RETIRED——候选按定义就是还开着的，永远退不了休。
  it("多候选时按错误里给的 id 传 predecessor 能真的接回，且不动另一条活会话", async () => {
    const { repository, managed } = await fixture("RSG");
    const first = repository.createSession(base);
    const second = repository.createSession(base);

    let candidates: string[] = [];
    try {
      repository.createSession({ ...base, resume: true });
      throw new Error("应当因多候选而拒绝");
    } catch (error) {
      expect(error).toMatchObject({ code: "SESSION_SUCCESSOR_AMBIGUOUS" });
      candidates = (error as { details?: { candidates?: string[] } }).details?.candidates ?? [];
    }
    // 阳性对照：提示里真的把两条候选都报出来了，否则下面只是在用测试自己知道的 id。
    expect(new Set(candidates)).toEqual(new Set([first.id, second.id]));

    const resumed = repository.createSession({
      ...base,
      resume: true,
      predecessorSessionId: candidates[0]!,
    });
    expect(resumed.id).toBe(candidates[0]!);
    expect(sessionCount(managed)).toBe(2);
    // 另一条活会话不能被顺手关掉。
    expect(connectionState(managed, first.id)).not.toBe("CLOSED");
    expect(connectionState(managed, second.id)).not.toBe("CLOSED");
  });

  it("指名的会话身份对不上时拒绝接回，不静默换成另一种身份", async () => {
    const { repository, managed } = await fixture("RSH");
    const primary = repository.createSession(base);

    expect(() =>
      repository.createSession({
        ...base,
        resume: true,
        role: "REVIEWER",
        predecessorSessionId: primary.id,
      }),
    ).toThrowError(expect.objectContaining({ code: "SESSION_SUCCESSOR_IDENTITY_MISMATCH" }));
    expect(sessionCount(managed)).toBe(1);
    expect(storedRole(managed, primary.id)).toBe("PRIMARY");
  });
});
