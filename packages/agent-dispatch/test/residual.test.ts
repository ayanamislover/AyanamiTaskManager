import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISPATCH_HISTORY_LIMIT,
  DispatchError,
  dispatchPaths,
  type DispatchRunView,
  PROCESS_IDENTITY_TOLERANCE_MS,
} from "../src/index.js";
import { defaultProcessStartTime, type KillResult, killProcessTree } from "../src/process.js";
import { checkProcessIdentity } from "../src/process-identity.js";
import { cleanupAll, fakeProcesses, fixture, waitFor } from "./support.js";

afterEach(cleanupAll);

const SUCCESS = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 4,
  duration_ms: 10,
  total_cost_usd: 0.5,
  result: "上次就做完了",
});

/** 残留用例里的 PID 只存在于替身的「活着」集合里，不对应任何真实进程。 */
const PID = 4_000_004;
const CREATED = new Date("2026-09-01T08:00:00.000Z");

type Seed = Partial<DispatchRunView> & {
  run: string;
  pid?: number;
  processCreatedAt?: string;
  log?: string;
};

function seed(dataDir: string, cwd: string, entries: Seed[]) {
  const paths = dispatchPaths(dataDir);
  mkdirSync(paths.logs, { recursive: true });
  const runs = entries.map((entry, index) => {
    const { log, ...rest } = entry;
    if (log !== undefined) writeFileSync(paths.stdoutLog(entry.run), log);
    return {
      project: "DEMO",
      key: `DEMO-T-${String(index + 1).padStart(4, "0")}`,
      title: "残留",
      origin: "desktop",
      state: "running",
      sessionId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
      startedAt: new Date().toISOString(),
      cwd,
      ...rest,
    };
  });
  writeFileSync(paths.runs, JSON.stringify({ v: 1, runs }));
  return paths;
}

async function rejection(promise: Promise<unknown>): Promise<DispatchError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DispatchError);
  return error as DispatchError;
}

describe("重启后修正残留的 running 记录", () => {
  it("进程已死：有 result 行判成功，没有判失败；从没结束过任何进程", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    seed(f.dataDir, f.projectDir, [
      { run: "a-00000001", pid: PID, log: `{"type":"system"}\n${SUCCESS}\n` },
      { run: "a-00000002", pid: PID, log: '{"type":"system"}\n' },
      { run: "a-00000003" },
    ]);
    const dispatcher = f.dispatcher(fake.options);
    await dispatcher.start();
    const byRun = new Map(dispatcher.listRuns().map((run) => [run.run, run]));
    expect(byRun.get("a-00000001")).toMatchObject({
      state: "succeeded",
      summary: { numTurns: 4, result: "上次就做完了" },
    });
    expect(byRun.get("a-00000002")).toMatchObject({ state: "failed" });
    expect(byRun.get("a-00000002")!.error).toContain("宿主重启时会话已结束");
    expect(byRun.get("a-00000003")).toMatchObject({ state: "failed" });
    const saved = JSON.parse(readFileSync(dispatchPaths(f.dataDir).runs, "utf8"));
    expect(saved.runs.map((run: { state: string }) => run.state)).toEqual([
      "succeeded",
      "failed",
      "failed",
    ]);
    expect(fake.kills).toEqual([]);
  });

  it("PID 活着但创建时间对不上（PID 被复用）：原进程肯定已退出，不接管，按日志判定", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    fake.alive.add(PID);
    fake.created.set(PID, new Date(CREATED.getTime() + 2 * 86_400_000));
    seed(f.dataDir, f.projectDir, [
      { run: "b-00000001", pid: PID, processCreatedAt: CREATED.toISOString(), log: `${SUCCESS}\n` },
      { run: "b-00000002", pid: PID, processCreatedAt: CREATED.toISOString(), log: "" },
    ]);
    const dispatcher = f.dispatcher(fake.options);
    await dispatcher.start();
    const byRun = new Map(dispatcher.listRuns().map((run) => [run.run, run]));
    expect(byRun.get("b-00000001")?.state).toBe("succeeded");
    expect(byRun.get("b-00000002")).toMatchObject({ state: "failed" });
    expect(byRun.get("b-00000002")!.error).toContain("宿主重启时会话已结束");
    expect(fake.kills).toEqual([]);
  });

  it("身份未知（记录里没有创建时间，或现在查不到）：绝不接管也不结束；没有 result 行就记失败并说明", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    const unknown = 4_000_008;
    fake.alive.add(PID);
    fake.alive.add(unknown);
    fake.created.set(PID, CREATED); // 现查得到，但记录里没存（旧版本留下的记录）
    seed(f.dataDir, f.projectDir, [
      { run: "c-00000001", pid: PID, log: `${SUCCESS}\n` },
      { run: "c-00000002", pid: PID, log: '{"type":"system"}\n' },
      // 记录里存了，但现在查不到（探测失败或超时）。
      { run: "c-00000003", pid: unknown, processCreatedAt: CREATED.toISOString(), log: "" },
    ]);
    const dispatcher = f.dispatcher(fake.options);
    await dispatcher.start();
    const byRun = new Map(dispatcher.listRuns().map((run) => [run.run, run]));
    // 日志里已有 result：会话已经结束，按日志定结局（PID 归谁都与它无关）。
    expect(byRun.get("c-00000001")?.state).toBe("succeeded");
    for (const [run, pid] of [
      ["c-00000002", PID],
      ["c-00000003", unknown],
    ] as const) {
      const view = byRun.get(run)!;
      expect(view.state).toBe("failed");
      expect(view.error).toContain("宿主重启后无法确认 Claude 进程身份");
      expect(view.error).toContain(`PID ${pid}`);
      expect(view.error).toContain("没有结束该进程");
      expect(view.error).toContain("任务管理器");
    }
    // 不在跟踪：取消只会说「已结束」，不会去结束那个 PID。
    expect((await rejection(dispatcher.cancel("c-00000002"))).code).toBe("DISPATCH_RUN_NOT_ACTIVE");
    await new Promise((done) => setTimeout(done, 200));
    expect(fake.kills).toEqual([]);
    expect(dispatcher.listRuns().filter((run) => run.state === "running")).toEqual([]);
  });

  it("身份一致才接管；接管后每次轮询都重核，进程退出后按日志定结局", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    fake.alive.add(PID);
    fake.created.set(PID, new Date(CREATED.getTime() + PROCESS_IDENTITY_TOLERANCE_MS));
    const paths = seed(f.dataDir, f.projectDir, [
      {
        run: "d-00000001",
        pid: PID,
        processCreatedAt: CREATED.toISOString(),
        log: '{"type":"system"}\n',
      },
    ]);
    let probes = 0;
    const dispatcher = f.dispatcher({
      ...fake.options,
      processStartTime: async (pid) => {
        probes += 1;
        return fake.created.get(pid) ?? null;
      },
    });
    await dispatcher.start();
    expect(dispatcher.listRuns()[0]?.state).toBe("running");
    await waitFor(() => probes >= 3);
    expect(dispatcher.listRuns()[0]?.state).toBe("running");
    writeFileSync(paths.stdoutLog("d-00000001"), `{"type":"system"}\n${SUCCESS}\n`);
    fake.alive.delete(PID);
    const done = await waitFor(() => {
      const run = dispatcher.listRuns()[0];
      return run?.state === "succeeded" ? run : null;
    });
    expect(done.summary?.numTurns).toBe(4);
    expect(fake.kills).toEqual([]);
  });

  it("接管后 PID 被复用（创建时间变了）：按已退出处理，不结束新进程", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    fake.alive.add(PID);
    fake.created.set(PID, CREATED);
    seed(f.dataDir, f.projectDir, [
      { run: "e-00000001", pid: PID, processCreatedAt: CREATED.toISOString(), log: "" },
    ]);
    const dispatcher = f.dispatcher(fake.options);
    await dispatcher.start();
    expect(dispatcher.listRuns()[0]?.state).toBe("running");
    // 原进程退出、PID 立刻被别的进程拿走：PID 仍「活着」，只有创建时间能看出换了人。
    fake.created.set(PID, new Date(CREATED.getTime() + PROCESS_IDENTITY_TOLERANCE_MS + 1));
    const done = await waitFor(() => {
      const run = dispatcher.listRuns()[0];
      return run?.state !== "running" ? run : null;
    });
    expect(done.state).toBe("failed");
    expect(fake.kills).toEqual([]);
  });

  it("接管后连续几次查不到创建时间：停止跟踪、记失败并说明，不结束进程", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    fake.alive.add(PID);
    fake.created.set(PID, CREATED);
    seed(f.dataDir, f.projectDir, [
      { run: "g-00000001", pid: PID, processCreatedAt: CREATED.toISOString(), log: "" },
    ]);
    const dispatcher = f.dispatcher(fake.options);
    await dispatcher.start();
    expect(dispatcher.listRuns()[0]?.state).toBe("running");
    fake.created.delete(PID);
    const done = await waitFor(() => {
      const run = dispatcher.listRuns()[0];
      return run?.state !== "running" ? run : null;
    });
    expect(done.state).toBe("failed");
    expect(done.error).toContain("无法确认 Claude 进程身份");
    expect(done.error).toContain("没有结束该进程");
    expect(fake.alive.has(PID)).toBe(true);
    expect(fake.kills).toEqual([]);
  });

  it("接管的会话被取消：取消前重核身份；一致才结束，换了人按已退出处理，核验不了就拒绝并保持运行", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    const [same, reused, unknown] = [4_000_100, 4_000_104, 4_000_108];
    for (const pid of [same, reused, unknown]) {
      fake.alive.add(pid);
      fake.created.set(pid, CREATED);
    }
    seed(f.dataDir, f.projectDir, [
      { run: "k-00000001", pid: same, processCreatedAt: CREATED.toISOString(), log: "" },
      { run: "k-00000002", pid: reused, processCreatedAt: CREATED.toISOString(), log: "" },
      { run: "k-00000003", pid: unknown, processCreatedAt: CREATED.toISOString(), log: "" },
    ]);
    // 轮询间隔拉长：只看取消前的那一次核验。
    const dispatcher = f.dispatcher({ ...fake.options, pollIntervalMs: 60_000 });
    await dispatcher.start();
    expect(dispatcher.listRuns().every((run) => run.state === "running")).toBe(true);

    expect(await dispatcher.cancel("k-00000001")).toMatchObject({ state: "cancelled" });
    expect(fake.kills).toEqual([same]);

    fake.created.set(reused, new Date(CREATED.getTime() + 60_000));
    const exited = await dispatcher.cancel("k-00000002");
    expect(exited.state).toBe("failed"); // 按日志判定：原会话没写 result。
    expect(fake.kills).toEqual([same]);

    fake.created.delete(unknown);
    const refused = await rejection(dispatcher.cancel("k-00000003"));
    expect(refused.code).toBe("DISPATCH_CANCEL_FAILED");
    expect(refused.httpStatus).toBe(500);
    expect(refused.message).toContain("没有结束任何进程");
    expect(dispatcher.listRuns().find((run) => run.run === "k-00000003")?.state).toBe("running");
    expect(fake.kills).toEqual([same]);
  });

  it("身份核验的容差只吸收精度差（≤ 2 秒），不是宽松时间窗", async () => {
    expect(PROCESS_IDENTITY_TOLERANCE_MS).toBeLessThanOrEqual(2_000);
    const probe = (created: Date | null, alive = true) => ({
      isAlive: () => alive,
      startTime: async () => created,
      killTree: async (): Promise<KillResult> => {
        throw new Error("核验不应结束进程");
      },
    });
    const at = (offset: number) => new Date(CREATED.getTime() + offset);
    const recorded = CREATED.toISOString();
    expect(await checkProcessIdentity(probe(at(0)), PID, recorded)).toBe("same");
    expect(await checkProcessIdentity(probe(at(-999)), PID, recorded)).toBe("same");
    expect(await checkProcessIdentity(probe(at(5_000)), PID, recorded)).toBe("different");
    expect(await checkProcessIdentity(probe(at(60_000)), PID, recorded)).toBe("different");
    expect(await checkProcessIdentity(probe(null), PID, recorded)).toBe("unknown");
    expect(await checkProcessIdentity(probe(at(0)), PID, undefined)).toBe("unknown");
    expect(await checkProcessIdentity(probe(at(0), false), PID, recorded)).toBe("gone");
  });

  it("默认的创建时间探测能认出当前进程，死进程返回 null（只读探测）", async () => {
    const created = await defaultProcessStartTime(process.pid);
    expect(created).toBeInstanceOf(Date);
    expect(created!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(Date.now() - created!.getTime()).toBeLessThan(6 * 3_600_000);
    const child = spawn(process.execPath, ["-e", "0"], { windowsHide: true });
    await new Promise((done) => child.once("exit", done));
    expect(await defaultProcessStartTime(child.pid!)).toBeNull();
  }, 60_000);

  it("默认的结束进程树：进程不存在时报 gone（PID 取不可能存在的奇数，Windows 的 PID 都是 4 的倍数）", async () => {
    expect(await killProcessTree(99_999_997)).toEqual({ kind: "gone" });
    expect(await killProcessTree(0)).toEqual({ kind: "gone" });
  }, 60_000);
});

describe("历史与日志上限", () => {
  it(`只留最近 ${DISPATCH_HISTORY_LIMIT} 次，旧日志一并删掉`, async () => {
    const f = fixture();
    const entries: Seed[] = Array.from({ length: 60 }, (_, index) => ({
      run: `h${String(index).padStart(3, "0")}-00000000`,
      state: "succeeded",
      log: `${SUCCESS}\n`,
    }));
    const paths = seed(f.dataDir, f.projectDir, entries);
    writeFileSync(paths.stderrLog("h000-00000000"), "old");
    writeFileSync(`${paths.logs}/unrelated.txt`, "留着");
    const dispatcher = f.dispatcher();
    await dispatcher.start();
    const runs = dispatcher.listRuns();
    expect(runs).toHaveLength(DISPATCH_HISTORY_LIMIT);
    expect(runs[0]!.run).toBe("h059-00000000");
    expect(runs.at(-1)!.run).toBe("h010-00000000");
    const files = readdirSync(paths.logs);
    expect(files.filter((name) => name.endsWith(".jsonl"))).toHaveLength(DISPATCH_HISTORY_LIMIT);
    expect(existsSync(paths.stdoutLog("h009-00000000"))).toBe(false);
    expect(existsSync(paths.stderrLog("h000-00000000"))).toBe(false);
    expect(files).toContain("unrelated.txt");
    expect(JSON.parse(readFileSync(paths.runs, "utf8")).runs).toHaveLength(DISPATCH_HISTORY_LIMIT);
  });

  it("坏的历史文件从空历史开始并记日志", async () => {
    const f = fixture();
    const paths = dispatchPaths(f.dataDir);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.runs, "{ 坏");
    const dispatcher = f.dispatcher();
    await dispatcher.start();
    expect(dispatcher.listRuns()).toEqual([]);
    expect(f.warnings.length).toBeGreaterThan(0);
  });
});
