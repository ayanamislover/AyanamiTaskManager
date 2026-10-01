import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createAgentDispatcher,
  DEFAULT_DISPATCH_CONFIG,
  dispatchPaths,
} from "@ayanami-task/agent-dispatch";
import { AyanamiTaskService } from "@ayanami-task/application";
import { startMobileFeatures, type MobileFeatureOptions } from "../src/core-mobile.js";
import { hostDpapi } from "../src/dpapi.js";
import { HostControlSession } from "../src/host-control-session.js";

/**
 * 手机同步与派单在 core 里的生命周期（ATM-T-0571 / peer R1-01）：它们是可选功能，
 * DPAPI helper 慢了、挂了，或者派单器起不来，都不能拖住与宿主的握手，也不能拖住退出。
 */
const scratchRoot = resolve(process.cwd(), "output");
mkdirSync(scratchRoot, { recursive: true });
const work = mkdtempSync(join(scratchRoot, "core-mobile-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const fakeHost = resolve(process.cwd(), "apps/desktop/test/fixtures/fake-dpapi.mjs");
let counter = 0;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  delete process.env.FAKE_DPAPI_MODE;
  delete process.env.FAKE_DPAPI_PID_DIR;
});

type Overrides = Partial<Omit<MobileFeatureOptions, "service" | "dataDir" | "hostPath">> & {
  dpapiTimeoutMs?: number;
};

async function open(overrides: Overrides = {}) {
  const dataDir = join(work, `case-${(counter += 1)}`);
  mkdirSync(dataDir, { recursive: true });
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const { dpapiTimeoutMs, ...rest } = overrides;
  const features = startMobileFeatures({
    service,
    dataDir,
    hostPath: process.execPath,
    dpapi: (signal) =>
      hostDpapi(process.execPath, {
        prefixArgs: [fakeHost],
        signal,
        ...(dpapiTimeoutMs ? { timeoutMs: dpapiTimeoutMs } : {}),
      }),
    ...rest,
  });
  cleanups.push(async () => {
    await features.close();
    service.close();
  });
  return { dataDir, service, features };
}

/** 让假 helper 卡住，并把自己的 PID 留在一个目录里。 */
function hangingHelpers(): string {
  const directory = join(work, `pids-${(counter += 1)}`);
  mkdirSync(directory, { recursive: true });
  process.env.FAKE_DPAPI_MODE = "hang";
  process.env.FAKE_DPAPI_PID_DIR = directory;
  return directory;
}

async function firstPid(directory: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [name] = readdirSync(directory);
    if (name) return Number(name);
    if (Date.now() > deadline) throw new Error("helper 没有起来");
    await new Promise((done) => setTimeout(done, 20));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (alive(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
  return !alive(pid);
}

describe("core 里的手机同步与派单", () => {
  it("DPAPI helper 挂住：握手照常完成；同步还在启动时路由回 503，helper 超时后如实报告不可用", async () => {
    const pids = hangingHelpers();
    const input = new PassThrough();
    const output = new PassThrough();
    const closes: string[] = [];
    let opened: Awaited<ReturnType<typeof open>> | null = null;
    // 与 core-main 的 onHello 同样的组合：打开 service、起手机功能，然后就绪。
    const session = new HostControlSession({
      input,
      output,
      async onHello() {
        opened = await open({ dpapiTimeoutMs: 1500, featureWaitMs: 100 });
      },
      onClose: (reason) => closes.push(reason),
    });
    cleanups.push(async () => {
      session.close("shutdown");
      input.destroy();
      output.destroy();
    });
    session.start();
    input.write(
      `${JSON.stringify({
        t: "hello",
        v: 1,
        runId: "core-mobile-test",
        version: "test",
        launch: { background: true, agentWake: false, randomStartupDelay: false },
      })}\n`,
    );
    const deadline = Date.now() + 5000;
    while (!session.open && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 10));
    expect(session.open).toBe(true);
    expect(closes).toEqual([]);
    // 握手完成时 helper 还卡着：说明就绪没有等 DPAPI。
    const pid = await firstPid(pids);
    expect(alive(pid)).toBe(true);
    const { features } = opened!;
    await expect(features.sync.status()).rejects.toMatchObject({
      code: "SYNC_STARTING",
      httpStatus: 503,
      retryable: true,
    });
    await features.ready;
    const status = (await features.sync.status()) as Record<string, unknown>;
    expect(status).toMatchObject({
      enabled: false,
      state: "disabled",
      secretStore: "os-encrypted",
    });
    expect(String(status.lastError)).toContain("DPAPI");
    expect(await features.dispatch.status()).toMatchObject({ enabled: false });
    expect(await gone(pid)).toBe(true);
  }, 20_000);

  it("还在启动就收尾：中止卡住的 helper，close 有上限；之后路由回 404 而不是挂住", async () => {
    const pids = hangingHelpers();
    const { features } = await open();
    const pid = await firstPid(pids);
    const began = performance.now();
    await features.close();
    expect(performance.now() - began).toBeLessThan(2500);
    expect(await gone(pid)).toBe(true);
    await expect(features.sync.status()).rejects.toMatchObject({
      code: "SYNC_UNAVAILABLE",
      httpStatus: 404,
    });
  }, 20_000);

  it("派单器起不来不连累同步：派单路由 404 DISPATCH_UNAVAILABLE，同步照常可用", async () => {
    const { features } = await open({
      createDispatcher: () => Promise.reject(new Error("dispatch store unreadable")),
    });
    await features.ready;
    expect(await features.sync.status()).toMatchObject({
      enabled: false,
      secretStore: "os-encrypted",
      lastError: null,
    });
    await expect(features.dispatch.status()).rejects.toMatchObject({
      code: "DISPATCH_UNAVAILABLE",
      httpStatus: 404,
    });
  });

  it("startMobileFeatures 立即返回（不是 Promise），core-main 也不去等它就绪", () => {
    const features = startMobileFeatures({
      service: {} as AyanamiTaskService,
      dataDir: join(work, `case-${(counter += 1)}`),
      hostPath: process.execPath,
      dpapi: () => null,
      createDispatcher: () => new Promise(() => undefined),
    });
    cleanups.push(() => features.close());
    expect("then" in features).toBe(false);
    // core-main 在 onHello 里起手机功能；等它就绪就又把 DPAPI 与派单恢复拉回握手时间里了。
    const coreMain = readFileSync(resolve(process.cwd(), "apps/desktop/src/core-main.ts"), "utf8");
    expect(coreMain).toMatch(/mobile = startMobileFeatures\(\{/u);
    expect(coreMain).not.toMatch(/await\s+(?:startMobileFeatures|mobile\??\.ready)/u);
  });

  it("就绪之后收尾：路由一律回 404「正在退出」，不再转给已停的连接器与派单器", async () => {
    const { features } = await open();
    await features.ready;
    expect(await features.sync.status()).toMatchObject({ enabled: false });
    await features.close();
    await expect(features.sync.status()).rejects.toMatchObject({
      code: "SYNC_UNAVAILABLE",
      httpStatus: 404,
      message: expect.stringContaining("正在退出"),
    });
    await expect(features.dispatch.status()).rejects.toMatchObject({
      code: "DISPATCH_UNAVAILABLE",
      httpStatus: 404,
    });
  });

  it("派单恢复慢过收尾等待：close 之后恢复回来也不再读任务、不再起会话（peer R2-03）", async () => {
    const dataDir = join(work, `case-${(counter += 1)}`);
    const paths = dispatchPaths(dataDir);
    mkdirSync(paths.logs, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ ...DEFAULT_DISPATCH_CONFIG, enabled: true }));
    const common = {
      project: "DEMO",
      title: "合成记录",
      origin: "desktop",
      sessionId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      createdAt: new Date().toISOString(),
      cwd: dataDir,
    };
    writeFileSync(
      paths.runs,
      JSON.stringify({
        v: 1,
        runs: [
          // PID 只存在于注入的探针里，不对应任何真实进程。
          {
            ...common,
            run: "a-00000001",
            key: "DEMO-T-0001",
            state: "running",
            pid: 4_000_004,
            processIdentity: "synthetic-before",
            startedAt: new Date().toISOString(),
          },
          { ...common, run: "a-00000002", key: "DEMO-T-0002", state: "queued" },
        ],
      }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    let closed = false;
    const late: string[] = [];
    const service = {
      subscribeGlobal: () => () => undefined,
      getWorkItemForUi: async () => {
        if (closed) late.push("getWorkItemForUi");
        throw new Error("synthetic closed service");
      },
    } as unknown as AyanamiTaskService;
    const features = startMobileFeatures({
      service,
      dataDir,
      hostPath: process.execPath,
      dpapi: () => null,
      createDispatcher: (options) =>
        createAgentDispatcher({
          ...options,
          resolveClaude: () => "synthetic-claude.exe",
          isPidAlive: () => true,
          processIdentity: async () => {
            entered = true;
            await gate;
            return "synthetic-after";
          },
          killProcessTree: async () => {
            throw new Error("must never kill");
          },
          spawnImpl: () => {
            throw new Error("must never spawn");
          },
        }),
    });
    cleanups.push(async () => {
      release();
      await features.close();
    });
    const deadline = Date.now() + 5000;
    while (!entered && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
    expect(entered).toBe(true);
    await features.close();
    closed = true;
    release();
    await features.ready;
    await new Promise((done) => setTimeout(done, 50));
    expect(late).toEqual([]);
    const saved = JSON.parse(readFileSync(paths.runs, "utf8")) as {
      runs: Array<{ state: string }>;
    };
    expect(saved.runs.map((run) => run.state)).toEqual(["running", "queued"]);
  });
});
