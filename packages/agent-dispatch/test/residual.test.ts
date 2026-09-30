import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentDispatcher,
  DISPATCH_HISTORY_LIMIT,
  dispatchPaths,
  type DispatchRunView,
} from "../src/index.js";
import { defaultProcessStartTime, isPidAlive } from "../src/process.js";
import { cleanupAll, FAKE_CLAUDE, type Fixture, fixture, waitFor } from "./support.js";

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

type Seed = Partial<DispatchRunView> & { run: string; pid?: number; log?: string };

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

/**
 * 用 process.pid 冒充残留会话的用例不走 fixture 的调度器：afterEach 会取消仍在跑的派单，
 * 而取消会结束那个 PID 的整棵进程树——也就是测试进程自己。
 */
function unmanaged(f: Fixture, processStartTime: (pid: number) => Promise<Date | null>) {
  return new AgentDispatcher({
    dataDir: f.dataDir,
    host: f.host,
    resolveClaude: () => FAKE_CLAUDE,
    logger: f.logger,
    pollIntervalMs: 50,
    processStartTime,
  });
}

/** 起一个立即退出的进程，拿到一个「刚死掉」的 PID。 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"], { windowsHide: true });
  await new Promise((done) => child.once("exit", done));
  return child.pid!;
}

describe("重启后修正残留的 running 记录", () => {
  it("进程已死：有 result 行判成功，没有判失败", async () => {
    const f = fixture();
    const pid = await deadPid();
    seed(f.dataDir, f.projectDir, [
      { run: "a-00000001", pid, log: `{"type":"system"}\n${SUCCESS}\n` },
      { run: "a-00000002", pid, log: '{"type":"system"}\n' },
      { run: "a-00000003" },
    ]);
    const dispatcher = f.dispatcher();
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
  });

  it("PID 活着但创建时间对不上（PID 被复用）：不接管，按日志判定", async () => {
    const f = fixture();
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    seed(f.dataDir, f.projectDir, [
      { run: "b-00000001", pid: process.pid, startedAt: twoDaysAgo, log: `${SUCCESS}\n` },
    ]);
    const dispatcher = unmanaged(f, async () => new Date());
    try {
      await dispatcher.start();
      expect(dispatcher.listRuns()[0]).toMatchObject({ state: "succeeded" });
    } finally {
      dispatcher.close();
    }
  });

  it("拿不到创建时间：日志里有 result 行就当已结束，没有就继续跟踪", async () => {
    const f = fixture();
    seed(f.dataDir, f.projectDir, [
      { run: "c-00000001", pid: process.pid, log: `${SUCCESS}\n` },
      { run: "c-00000002", pid: process.pid, log: '{"type":"system"}\n' },
    ]);
    const dispatcher = unmanaged(f, async () => null);
    try {
      await dispatcher.start();
      const byRun = new Map(dispatcher.listRuns().map((run) => [run.run, run]));
      expect(byRun.get("c-00000001")?.state).toBe("succeeded");
      expect(byRun.get("c-00000002")?.state).toBe("running");
    } finally {
      dispatcher.close();
    }
  });

  it("同一个进程还活着：接着跟踪，进程结束后按日志定结局", async () => {
    const f = fixture();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    const startedAt = new Date().toISOString();
    const paths = seed(f.dataDir, f.projectDir, [
      { run: "d-00000001", pid: child.pid!, startedAt, log: '{"type":"system"}\n' },
    ]);
    try {
      const dispatcher = f.dispatcher({ processStartTime: async () => new Date(startedAt) });
      await dispatcher.start();
      expect(dispatcher.listRuns()[0]?.state).toBe("running");
      writeFileSync(paths.stdoutLog("d-00000001"), `{"type":"system"}\n${SUCCESS}\n`);
      child.kill();
      const done = await waitFor(() => {
        const run = dispatcher.listRuns()[0];
        return run?.state === "succeeded" ? run : null;
      });
      expect(done.summary?.numTurns).toBe(4);
    } finally {
      if (isPidAlive(child.pid!)) child.kill();
    }
  });

  it("默认的创建时间探测能认出当前进程，死进程返回 null", async () => {
    const created = await defaultProcessStartTime(process.pid);
    expect(created).toBeInstanceOf(Date);
    expect(created!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(Date.now() - created!.getTime()).toBeLessThan(6 * 3_600_000);
    expect(await defaultProcessStartTime(await deadPid())).toBeNull();
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
