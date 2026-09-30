import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DispatchError,
  type DispatchChangeEvent,
  dispatchPaths,
  renderDispatchPrompt,
  type DispatchSpawn,
} from "../src/index.js";
import { cleanupAll, dumpExists, FAKE_CLAUDE, fixture, waitFor } from "./support.js";

afterEach(cleanupAll);

async function rejection(promise: Promise<unknown>): Promise<DispatchError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DispatchError);
  return error as DispatchError;
}

describe("排队前的校验", () => {
  it("逐个拒绝码：关闭、键名、找不到 claude、项目、目录、任务、状态、领取、重复", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    const off = f.dispatcher();
    const enqueue = (key = "DEMO-T-0001", project = "DEMO") =>
      off.enqueue({ project, key, origin: "desktop" });
    expect((await rejection(enqueue())).code).toBe("DISPATCH_DISABLED");
    await off.updateConfig({ enabled: true });

    expect((await rejection(enqueue("demo-t-1"))).code).toBe("DISPATCH_INVALID_ARGUMENT");
    const noClaude = f.dispatcher({ resolveClaude: () => null });
    expect(
      (await rejection(noClaude.enqueue({ project: "DEMO", key: "DEMO-T-0001", origin: "mobile" })))
        .code,
    ).toBe("DISPATCH_CLAUDE_NOT_FOUND");
    expect((await rejection(enqueue("NOPE-T-0001", "NOPE"))).code).toBe(
      "DISPATCH_PROJECT_NOT_FOUND",
    );

    f.host.projects.set("BARE", { code: "BARE", name: "没绑目录", paths: [] });
    f.host.projects.set("GONE", { code: "GONE", name: "目录没了", paths: [join(f.root, "x")] });
    const bare = await rejection(enqueue("BARE-T-0001", "BARE"));
    expect(bare.code).toBe("DISPATCH_PROJECT_PATH_MISSING");
    expect(bare.message).toContain("没有绑定工作目录");
    expect((await rejection(enqueue("GONE-T-0001", "GONE"))).code).toBe(
      "DISPATCH_PROJECT_PATH_MISSING",
    );

    expect((await rejection(enqueue("DEMO-T-0404"))).code).toBe("DISPATCH_TASK_NOT_FOUND");
    expect((await rejection(enqueue("OTHER-T-0001"))).code).toBe("DISPATCH_TASK_NOT_FOUND");
    f.addTask("DEMO-T-0002", { status: "IN_PROGRESS" });
    expect((await rejection(enqueue("DEMO-T-0002"))).code).toBe("DISPATCH_TASK_NOT_READY");
    const future = new Date(Date.now() + 60_000).toISOString();
    f.addTask("DEMO-T-0003", { claimedBySessionId: "S1", claimLeaseUntil: future });
    const claimed = await rejection(enqueue("DEMO-T-0003"));
    expect(claimed.code).toBe("DISPATCH_TASK_NOT_READY");
    expect(claimed.details).toMatchObject({ claimedBySessionId: "S1" });
    expect(claimed.httpStatus).toBe(409);

    // 过期的领取不挡派单；BACKLOG 也可以派。
    f.behave("slow", 60_000);
    const past = new Date(Date.now() - 60_000).toISOString();
    f.addTask("DEMO-T-0004", {
      status: "BACKLOG",
      claimedBySessionId: "S2",
      claimLeaseUntil: past,
    });
    const accepted = await enqueue("DEMO-T-0004");
    expect(accepted.state).toBe("queued");
    const duplicate = await rejection(enqueue("DEMO-T-0004"));
    expect(duplicate.code).toBe("DISPATCH_ALREADY_ACTIVE");
    expect(duplicate.details).toMatchObject({ run: accepted.run });
  });
});

describe("启动与结局", () => {
  it("成功：参数、stdin 提示词、工作目录、日志落盘、环境剥离、摘要与事件都对", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001", { title: "把派单做完" });
    const captured: Array<Parameters<DispatchSpawn>[2]> = [];
    const dispatcher = f.dispatcher({
      spawnImpl: (command, args, options) => {
        captured.push(options);
        return spawn(command, args, options);
      },
      baseEnv: {
        ...process.env,
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
        CLAUDE_CODE_SSE_PORT: "5555",
        CLAUDE_CODE_SESSION_ID: "host-session",
        AYANAMI_TASK_USER_TOKEN: "user-secret",
        KEEP_DISPATCH_VALUE: "kept",
        HTTPS_PROXY: "http://127.0.0.1:7890",
      },
    });
    await dispatcher.updateConfig({ enabled: true, model: "sonnet", effort: "high" });
    const events: DispatchChangeEvent[] = [];
    dispatcher.onChange((event) => events.push(event));

    const queued = await dispatcher.enqueue({
      project: "DEMO",
      key: "DEMO-T-0001",
      origin: "mobile",
      requestedBy: "Pixel\n9",
    });
    const done = await waitFor(() => {
      const run = dispatcher.runForTask("DEMO", "DEMO-T-0001");
      return run?.state === "succeeded" ? run : null;
    });
    expect(done).toMatchObject({
      run: queued.run,
      title: "把派单做完",
      origin: "mobile",
      exitCode: 0,
      summary: { numTurns: 3, durationMs: 1234, totalCostUsd: 0.0123 },
    });
    expect(Array.from(done.summary!.result)).toHaveLength(500);
    expect(done.startedAt).toBeDefined();
    expect(done.endedAt).toBeDefined();
    expect(events.filter((event) => event.type === "run").map((event) => event.run.state)).toEqual([
      "queued",
      "running",
      "succeeded",
    ]);

    const dump = f.dump(queued.run);
    expect(dump.args).toEqual([
      "-p",
      "--permission-mode",
      "auto",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      queued.sessionId,
      "--name",
      "ATM · DEMO-T-0001",
      "--model",
      "sonnet",
      "--effort",
      "high",
    ]);
    expect(dump.stdin).toBe(
      renderDispatchPrompt({
        run: queued.run,
        projectCode: "DEMO",
        projectName: "演示项目",
        cwd: f.projectDir,
        key: "DEMO-T-0001",
        title: "把派单做完",
        origin: "mobile",
        requestedBy: "Pixel 9",
      }),
    );
    expect(dump.cwd.toLowerCase()).toBe(f.projectDir.toLowerCase());
    const names = dump.envNames.map((name) => name.toUpperCase());
    for (const stripped of [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SSE_PORT",
      "CLAUDE_CODE_SESSION_ID",
      "AYANAMI_TASK_USER_TOKEN",
    ])
      expect(names).not.toContain(stripped);
    expect(dump.env).toMatchObject({
      ATM_DISPATCH_RUN: queued.run,
      KEEP_DISPATCH_VALUE: "kept",
      HTTPS_PROXY: "http://127.0.0.1:7890",
    });

    expect(captured[0]).toMatchObject({ detached: true, windowsHide: true, cwd: f.projectDir });
    expect(captured[0]!.stdio).toEqual(["pipe", expect.any(Number), expect.any(Number)]);
    const paths = dispatchPaths(f.dataDir);
    const log = readFileSync(paths.stdoutLog(queued.run), "utf8");
    expect(log).toContain('"type":"result"');
    expect(existsSync(paths.stderrLog(queued.run))).toBe(true);
    const saved = JSON.parse(readFileSync(paths.runs, "utf8"));
    expect(saved.runs[0]).toMatchObject({ run: queued.run, state: "succeeded", pid: dump.pid });
  });

  it("失败：没有 result 行按退出码与 stderr 判；登录失败的 result 行也算失败", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    f.addTask("DEMO-T-0002");
    const dispatcher = f.dispatcher();
    await dispatcher.updateConfig({ enabled: true });
    f.behave("fail");
    await dispatcher.enqueue({ project: "DEMO", key: "DEMO-T-0001", origin: "desktop" });
    const failed = await waitFor(() => {
      const run = dispatcher.runForTask("DEMO", "DEMO-T-0001");
      return run?.state === "failed" ? run : null;
    });
    expect(failed.exitCode).toBe(2);
    expect(failed.error).toContain("fake-claude: boom");

    f.behave("error-result");
    await dispatcher.enqueue({ project: "DEMO", key: "DEMO-T-0002", origin: "desktop" });
    const auth = await waitFor(() => {
      const run = dispatcher.runForTask("DEMO", "DEMO-T-0002");
      return run?.state === "failed" ? run : null;
    });
    expect(auth.error).toContain("Failed to authenticate");
    expect(auth.summary).toMatchObject({ numTurns: 1 });
  });

  it("spawn 同步抛错：记为失败，错误原因原样保留，不影响后续派单", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    const dispatcher = f.dispatcher({
      spawnImpl: () => {
        throw new Error("spawn EINVAL");
      },
    });
    await dispatcher.updateConfig({ enabled: true });
    await dispatcher.enqueue({ project: "DEMO", key: "DEMO-T-0001", origin: "desktop" });
    const failed = await waitFor(() => {
      const run = dispatcher.runForTask("DEMO", "DEMO-T-0001");
      return run?.state === "failed" ? run : null;
    });
    expect(failed.error).toBe("启动失败：spawn EINVAL");
    expect(dispatcher.listRuns().filter((run) => run.state === "running")).toEqual([]);
  });

  it("status 带 claude 路径与版本（只取一次）", async () => {
    const f = fixture();
    const dispatcher = f.dispatcher();
    const status = await dispatcher.status();
    expect(status).toMatchObject({
      enabled: false,
      permissionMode: "auto",
      maxConcurrent: 1,
      claude: { found: true, path: FAKE_CLAUDE, version: "9.9.9 (Fake Claude)" },
      runs: [],
    });
    const missing = await f.dispatcher({ resolveClaude: () => null }).status();
    expect(missing.claude).toEqual({ found: false, path: null });
  });
});

describe("排队、并发与取消", () => {
  it("并发上限 1：第二个排队，第一个结束后才启动", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    f.addTask("DEMO-T-0002");
    f.behave("slow", 700);
    const dispatcher = f.dispatcher();
    await dispatcher.updateConfig({ enabled: true, maxConcurrent: 1 });
    const first = await dispatcher.enqueue({
      project: "DEMO",
      key: "DEMO-T-0001",
      origin: "mobile",
    });
    const second = await dispatcher.enqueue({
      project: "DEMO",
      key: "DEMO-T-0002",
      origin: "mobile",
    });
    await waitFor(() => dispatcher.runForTask("DEMO", "DEMO-T-0001")?.state === "running");
    expect(dispatcher.runForTask("DEMO", "DEMO-T-0002")?.state).toBe("queued");
    const done = await waitFor(() => {
      const runs = dispatcher.listRuns();
      return runs.every((run) => run.state === "succeeded") ? runs : null;
    });
    const [later, earlier] = done;
    expect(later!.run).toBe(second.run);
    expect(earlier!.run).toBe(first.run);
    expect(Date.parse(later!.startedAt!)).toBeGreaterThanOrEqual(Date.parse(earlier!.endedAt!));
  });

  it("并发上限 2：两个同时跑", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    f.addTask("DEMO-T-0002");
    f.addTask("DEMO-T-0003");
    f.behave("slow", 60_000);
    const dispatcher = f.dispatcher();
    await dispatcher.updateConfig({ enabled: true, maxConcurrent: 2 });
    for (const key of ["DEMO-T-0001", "DEMO-T-0002", "DEMO-T-0003"])
      await dispatcher.enqueue({ project: "DEMO", key, origin: "desktop" });
    await waitFor(
      () => dispatcher.listRuns().filter((run) => run.state === "running").length === 2,
    );
    expect(dispatcher.runForTask("DEMO", "DEMO-T-0003")?.state).toBe("queued");
  });

  it("取消：运行中的会话整棵进程树被结束；排队中的直接取消；不能重复取消", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    f.addTask("DEMO-T-0002");
    f.behave("slow", 60_000);
    const dispatcher = f.dispatcher();
    await dispatcher.updateConfig({ enabled: true });
    const running = await dispatcher.enqueue({
      project: "DEMO",
      key: "DEMO-T-0001",
      origin: "desktop",
    });
    const queued = await dispatcher.enqueue({
      project: "DEMO",
      key: "DEMO-T-0002",
      origin: "desktop",
    });
    await waitFor(() => dumpExists(f.projectDir, running.run));
    const pid = f.dump(running.run).pid;

    expect((await dispatcher.cancel(queued.run)).state).toBe("cancelled");
    const cancelled = await dispatcher.cancel(running.run);
    expect(cancelled).toMatchObject({ state: "cancelled", error: "用户取消" });
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect((await rejection(dispatcher.cancel(running.run))).code).toBe("DISPATCH_RUN_NOT_ACTIVE");
    expect((await rejection(dispatcher.cancel("nope-00000000"))).code).toBe(
      "DISPATCH_RUN_NOT_FOUND",
    );
    // 取消腾出的名额不会把已取消的排队项再拉起来。
    expect(dumpExists(f.projectDir, queued.run)).toBe(false);
  });

  it("关闭派单会取消排队中的，运行中的照常跑完", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    f.addTask("DEMO-T-0002");
    f.behave("slow", 500);
    const dispatcher = f.dispatcher();
    await dispatcher.updateConfig({ enabled: true });
    const first = await dispatcher.enqueue({
      project: "DEMO",
      key: "DEMO-T-0001",
      origin: "desktop",
    });
    const second = await dispatcher.enqueue({
      project: "DEMO",
      key: "DEMO-T-0002",
      origin: "desktop",
    });
    await waitFor(() => dispatcher.runForTask("DEMO", "DEMO-T-0001")?.state === "running");
    await dispatcher.updateConfig({ enabled: false });
    expect(dispatcher.runForTask("DEMO", "DEMO-T-0002")).toMatchObject({
      run: second.run,
      state: "cancelled",
      error: "派单已关闭",
    });
    await waitFor(() => dispatcher.runForTask("DEMO", "DEMO-T-0001")?.state === "succeeded");
    expect(dispatcher.runForTask("DEMO", "DEMO-T-0001")?.run).toBe(first.run);
  });

  it("排队期间任务被别人领取：不起会话，记为取消并说明原因", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    f.addTask("DEMO-T-0002");
    f.behave("slow", 400);
    const dispatcher = f.dispatcher();
    await dispatcher.updateConfig({ enabled: true });
    await dispatcher.enqueue({ project: "DEMO", key: "DEMO-T-0001", origin: "desktop" });
    const second = await dispatcher.enqueue({
      project: "DEMO",
      key: "DEMO-T-0002",
      origin: "desktop",
    });
    f.addTask("DEMO-T-0002", { status: "IN_PROGRESS" });
    const result = await waitFor(() => {
      const run = dispatcher.runForTask("DEMO", "DEMO-T-0002");
      return run?.state === "cancelled" ? run : null;
    });
    expect(result.error).toContain("排队期间任务状态已变化");
    expect(dumpExists(f.projectDir, second.run)).toBe(false);
  });
});
