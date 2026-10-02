import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closedError, whileOpen } from "../src/admission.js";
import { ClaudeProbe } from "../src/claude-probe.js";
import {
  DEFAULT_DISPATCH_CONFIG,
  DispatchError,
  type DispatchHost,
  dispatchPaths,
} from "../src/index.js";
import { cleanupAll, fakeProcesses, type Fixture, fixture, waitFor } from "./support.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupAll();
});

/** 收集测试期间没人接的 Promise 拒绝（Node 默认会因此让进程退出，core 也不例外）。 */
async function unhandledDuring(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const record = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", record);
  try {
    await body();
    await new Promise((done) => setTimeout(done, 20));
  } finally {
    process.off("unhandledRejection", record);
  }
  return seen;
}

// 宿主收尾（core 的 abort → close）之后，派单器随后就要面对一个已经关掉的库：
// 已经进来的入队不再读库、不排队、不记账本；已在队列里的派单不因关闭后的读取失败被记成 failed。
// 下次启动时这些都照常处理：同一个 requestId 照常派出或回放。（peer R3-01 / R3-02）

/** 手机命令形的 requestId：发送时间写在 ID 里，取现在，免得被当成过期命令。 */
const commandId = (tag: string) =>
  `m-0123456789ab.${Date.now().toString(36).padStart(13, "0")}${tag.padStart(8, "0")}`;

const mobile = (requestId: string) => ({
  project: "DEMO",
  key: "DEMO-T-0001",
  origin: "mobile" as const,
  requestId,
});

/** 记下每次真正到达宿主的读库调用（派单器自己的关闭检查在它外面）。 */
function countingHost(f: Fixture, overrides: Partial<DispatchHost> = {}) {
  const calls: string[] = [];
  const host: DispatchHost = {
    getProject(code) {
      calls.push("getProject");
      return (overrides.getProject ?? f.host.getProject)(code);
    },
    getTask(code, key) {
      calls.push("getTask");
      return (overrides.getTask ?? f.host.getTask)(code, key);
    },
  };
  return { host, calls };
}

async function closedRejection(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DispatchError);
  expect(error).toMatchObject({ code: "DISPATCH_CLOSED", retryable: true });
}

/** 同一目录里下一次启动：同一个 requestId 照常派出（关闭时没被记成拒绝），只起一次会话。 */
async function nextStartDispatches(f: Fixture, requestId: string): Promise<void> {
  const fake = fakeProcesses();
  const next = f.dispatcher(fake.options);
  await next.start();
  await next.updateConfig({ enabled: true });
  const run = await next.enqueue(mobile(requestId));
  expect(run.state).toBe("queued");
  await waitFor(() => fake.children.length === 1);
  expect((await next.enqueue(mobile(requestId))).run).toBe(run.run);
  expect(fake.children).toHaveLength(1);
}

/** 历史里一条带 requestId 的排队派单（上次退出时还没轮到它）。 */
function seedQueued(f: Fixture, requestId: string) {
  const paths = dispatchPaths(f.dataDir);
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ ...DEFAULT_DISPATCH_CONFIG, enabled: true }));
  const queued = {
    run: "q-00000001",
    project: "DEMO",
    key: "DEMO-T-0001",
    title: "排队中",
    origin: "mobile",
    state: "queued",
    requestId,
    sessionId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    createdAt: new Date().toISOString(),
    cwd: f.projectDir,
  };
  writeFileSync(paths.runs, JSON.stringify({ v: 1, runs: [queued] }));
  return paths;
}

describe("关闭时已经进来的入队", () => {
  it("登录探测还没回来就关闭：立即以 DISPATCH_CLOSED 结束；探测回来后也不读库、不排队、不记账本", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    f.addTask("DEMO-T-0001");
    const authFile = join(f.root, "auth.json");
    writeFileSync(authFile, JSON.stringify({ mode: "hang" }));
    const { host, calls } = countingHost(f);
    const abort = new AbortController();
    const dispatcher = f.dispatcher({
      ...fake.options,
      host,
      signal: abort.signal,
      baseEnv: { ...process.env, FAKE_CLAUDE_AUTH_FILE: authFile },
      authProbeTimeoutMs: 1_500,
    });
    await dispatcher.updateConfig({ enabled: true });
    const requestId = commandId("auth");
    const enqueuing = dispatcher.enqueue(mobile(requestId));
    await waitFor(() => existsSync(`${authFile}.count`));
    const began = performance.now();
    abort.abort();
    await closedRejection(enqueuing);
    // 不等探测（它要到 1.5 s 超时才回来）。
    expect(performance.now() - began).toBeLessThan(500);
    await new Promise((done) => setTimeout(done, 1_800));
    expect(calls).toEqual([]);
    expect(dispatcher.listRuns()).toEqual([]);
    expect(fake.children).toEqual([]);
    await nextStartDispatches(f, requestId);
  });

  it("准入读到一半（项目读完、正要读任务）时关闭：不再读任务、不排队、不记账本", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    f.addTask("DEMO-T-0001");
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    let entered = false;
    const { host, calls } = countingHost(f, {
      getProject: async (code) => {
        entered = true;
        await gate;
        return f.host.getProject(code);
      },
    });
    const abort = new AbortController();
    const dispatcher = f.dispatcher({ ...fake.options, host, signal: abort.signal });
    await dispatcher.updateConfig({ enabled: true });
    const requestId = commandId("admit");
    const enqueuing = dispatcher.enqueue(mobile(requestId));
    await waitFor(() => entered);
    abort.abort();
    await closedRejection(enqueuing);
    release();
    await new Promise((done) => setTimeout(done, 50));
    expect(calls).toEqual(["getProject"]);
    expect(dispatcher.listRuns()).toEqual([]);
    expect(fake.children).toEqual([]);
    await nextStartDispatches(f, requestId);
  });

  it("关闭之后再入队（带不带 requestId）：直接 DISPATCH_CLOSED，不探登录、不读库", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    f.addTask("DEMO-T-0001");
    const authFile = join(f.root, "auth.json");
    const { host, calls } = countingHost(f);
    const dispatcher = f.dispatcher({
      ...fake.options,
      host,
      baseEnv: { ...process.env, FAKE_CLAUDE_AUTH_FILE: authFile },
    });
    await dispatcher.updateConfig({ enabled: true });
    dispatcher.close();
    const requestId = commandId("closed");
    await closedRejection(dispatcher.enqueue(mobile(requestId)));
    await closedRejection(
      dispatcher.enqueue({ project: "DEMO", key: "DEMO-T-0001", origin: "desktop" }),
    );
    // 探测进程要等 node 起来才记数：多等一会儿再看有没有被拉起过。
    await new Promise((done) => setTimeout(done, 1_000));
    expect(existsSync(`${authFile}.count`)).toBe(false);
    expect(calls).toEqual([]);
    await nextStartDispatches(f, requestId);
  });

  it("关闭之后再入队、派单又是关着的：仍是 DISPATCH_CLOSED，不把「未开启」记成这条命令的结局", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    f.addTask("DEMO-T-0001");
    const dispatcher = f.dispatcher(fake.options);
    dispatcher.close();
    const requestId = commandId("disabled");
    await closedRejection(dispatcher.enqueue(mobile(requestId)));
    await nextStartDispatches(f, requestId);
  });
});

describe("关闭时队列里的派单", () => {
  it.each(["getTask", "getProject"] as const)(
    "正在 %s 时关闭、随后读取失败：留在队列里不记 failed；下次启动照常起会话，同一 requestId 回放这一次",
    async (method) => {
      const f = fixture();
      const fake = fakeProcesses();
      f.addTask("DEMO-T-0001");
      const requestId = commandId(method);
      const paths = seedQueued(f, requestId);
      let fail!: (error: Error) => void;
      const gate = new Promise<never>((_resolve, reject) => (fail = reject));
      let entered = false;
      const stalled = () => {
        entered = true;
        return gate;
      };
      const abort = new AbortController();
      const closing = f.dispatcher({
        ...fake.options,
        signal: abort.signal,
        host:
          method === "getTask"
            ? { ...f.host, getTask: stalled }
            : { ...f.host, getProject: stalled },
      });
      await closing.start();
      await waitFor(() => entered);
      abort.abort();
      fail(new Error("库已关闭"));
      await new Promise((done) => setTimeout(done, 50));
      expect(closing.listRuns()[0]?.state).toBe("queued");
      expect(JSON.parse(readFileSync(paths.runs, "utf8")).runs[0].state).toBe("queued");
      expect(fake.children).toEqual([]);

      const nextFake = fakeProcesses();
      const next = f.dispatcher(nextFake.options);
      await next.start();
      await waitFor(() => nextFake.children.length === 1);
      expect((await next.enqueue(mobile(requestId))).run).toBe("q-00000001");
      expect(nextFake.children).toHaveLength(1);
      expect(JSON.parse(readFileSync(paths.runs, "utf8")).runs[0].state).toBe("running");
    },
  );

  it("没关闭时读取失败：照常记启动失败（只有关闭之后才把派单留在队列里）", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    f.addTask("DEMO-T-0001");
    seedQueued(f, commandId("open"));
    const dispatcher = f.dispatcher({
      ...fake.options,
      host: { ...f.host, getTask: () => Promise.reject(new Error("库读不出来")) },
    });
    await dispatcher.start();
    await waitFor(() => dispatcher.listRuns()[0]?.state === "failed");
    expect(dispatcher.listRuns()[0]?.error).toBe("启动失败：库读不出来");
    expect(fake.children).toEqual([]);
  });
});

describe("关闭时的 Promise 都有人接（peer R4-01）", () => {
  it("whileOpen 在已经关闭时也接住传进来的步骤：它随后失败不会变成未处理的拒绝", async () => {
    const lifetime = new AbortController();
    lifetime.abort();
    const unhandled = await unhandledDuring(async () => {
      await closedRejection(whileOpen(Promise.reject(closedError()), lifetime.signal));
      let fail!: (error: Error) => void;
      const later = new Promise<never>((_resolve, reject) => (fail = reject));
      await closedRejection(whileOpen(later, lifetime.signal));
      fail(new Error("库已关闭"));
    });
    expect(unhandled).toEqual([]);
  });

  it("登录探测刚回来、准入还没开始时关闭：逐个微任务时点扫一遍，入队要么照常排上、要么 DISPATCH_CLOSED，没有未处理的拒绝", async () => {
    const outcomes: string[] = [];
    const unhandled = await unhandledDuring(async () => {
      for (let phase = 0; phase <= 30; phase += 1) {
        const f = fixture();
        const fake = fakeProcesses();
        f.addTask("DEMO-T-0001");
        const dispatcher = f.dispatcher(fake.options);
        await dispatcher.updateConfig({ enabled: true });
        // 探测立即回「已登录」，同时排好在第 phase 个微任务之后关闭。
        vi.spyOn(ClaudeProbe.prototype, "auth").mockImplementation(async () => {
          let hop = Promise.resolve();
          for (let index = 0; index < phase; index += 1) hop = hop.then(() => undefined);
          void hop.then(() => dispatcher.close());
          return { state: { loggedIn: true }, fromCache: false };
        });
        const outcome = await dispatcher.enqueue(mobile(commandId(`p${phase}`))).then(
          (run) => run.state,
          (error: unknown) => (error as DispatchError).code,
        );
        outcomes.push(outcome);
        if (outcome === "DISPATCH_CLOSED") expect(dispatcher.listRuns()).toEqual([]);
        else expect(outcome).toBe("queued");
        vi.restoreAllMocks();
      }
    });
    expect(unhandled).toEqual([]);
    // 扫过的时点两头都覆盖到了：先关闭的被拒，晚关闭的已经排上。
    expect(outcomes).toContain("DISPATCH_CLOSED");
    expect(outcomes).toContain("queued");
  });
});
