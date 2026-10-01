import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_LAYOUT, assembleAppDirectory } from "../../../scripts/app-layout.js";

/**
 * 打包 core 的真实进程测试（ATM-T-0537 / 0520）：按发布布局组一个版本目录，
 * 用改名成 AyanamiTaskManager.exe 的 node 当假宿主，走真实 host-control 协议。
 */
const root = process.cwd();
const scratchRoot = resolve(root, "output");
let work = "";
let appDir = "";
let hostExe = "";

beforeAll(() => {
  execFileSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "apps/desktop/scripts/build-core.ts"],
    {
      cwd: root,
      stdio: "ignore",
    },
  );
  mkdirSync(scratchRoot, { recursive: true });
  work = mkdtempSync(join(scratchRoot, "core-process-"));
  appDir = assembleAppDirectory({
    root,
    target: join(work, "app"),
    hostExe: process.execPath,
    nodeExe: process.execPath,
  });
  hostExe = join(appDir, APP_LAYOUT.host);
}, 120_000);

afterAll(() => {
  // node:fs 的 rm 在 vitest-setup 里已包了有界重试（Windows 暂时性占用）。
  if (work) rmSync(work, { recursive: true, force: true });
});

function runFakeHost(
  dataDir: string,
  mode: "shutdown" | "disconnect" | "session-end" = "shutdown",
) {
  const result = spawnSync(
    hostExe,
    [
      resolve(root, "apps/desktop/test/fixtures/fake-host.mjs"),
      join(appDir, APP_LAYOUT.coreExe),
      join(appDir, APP_LAYOUT.coreBundle),
      mode,
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, ATM_DATA_DIR: dataDir, AYANAMI_TASK_TOKEN: "pinned-agent-token" },
    },
  );
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line || "{}") as Record<string, any>;
}

describe("打包 core 进程", () => {
  it("假宿主握手后，用户凭证经 core 写设置成功；伪造 Authorization 被丢弃；Agent 凭证写同一设置 403", async () => {
    const dataDir = join(work, "data-ok");
    const result = runFakeHost(dataDir);
    expect(result.ready, result.stderr).toMatchObject({
      t: "ready",
      v: 1,
      // SERVICE_HEALTHY 见证要的 core 身份。
      pid: expect.any(Number),
      startedAtMs: expect.any(Number),
      instanceId: expect.stringMatching(/^[a-f0-9]{32}$/u),
    });
    expect(result.res1).toMatchObject({ ok: true, value: { status: 200 } });
    expect(result.res2).toMatchObject({ ok: true, value: { status: 200 } });
    expect(JSON.parse(result.res2.value.body)).toMatchObject({ value: "CRITICAL" });
    expect(result.res3).toMatchObject({ ok: false, error: { code: "ATM_RENDERER_PATH_REJECTED" } });
    expect(result.res4).toMatchObject({ ok: true, value: true });
    expect(result.tray).toMatchObject({ t: "tray", snapshot: { notificationMode: "ALL" } });
    expect(result.agentTokenPinned).toBe(false);
    expect(result.agentWriteStatus).toBe(403);
    expect(result.res5.value.body).toContain('"CRITICAL"');
    expect(result.res5.value.body).not.toContain('"OFF"');
    // 手机同步与派单接上了，默认都关着。假宿主是 node，不认识 --dpapi：
    // 同步如实报告 DPAPI 不可用，而不是悄悄退回明文。
    expect(result.res6, result.stderr).toMatchObject({ ok: true, value: { status: 200 } });
    expect(JSON.parse(result.res6.value.body)).toMatchObject({
      enabled: false,
      state: "disabled",
      lastError: expect.stringContaining("DPAPI"),
    });
    expect(result.res7, result.stderr).toMatchObject({ ok: true, value: { status: 200 } });
    expect(JSON.parse(result.res7.value.body)).toMatchObject({ enabled: false, runs: [] });
    expect(result.exitCode).toBe(0);
    // 优雅退出清掉发现文件；打包版忽略继承来的固定 token。
    expect(existsSync(join(dataDir, "runtime", "daemon.json"))).toBe(false);
  }, 90_000);

  it("宿主断管：core 自己优雅退出并清发现文件", () => {
    const dataDir = join(work, "data-disconnect");
    const result = runFakeHost(dataDir, "disconnect");
    expect(result.ready, result.stderr).toBeTruthy();
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dataDir, "runtime", "daemon.json"))).toBe(false);
  }, 90_000);

  it("注销：core 收到 session-end 后同步落标记再回 marked；被系统硬杀后，下次启动记为 previous.session-end 而非 unclean", () => {
    const dataDir = join(work, "data-session-end");
    const ended = runFakeHost(dataDir, "session-end");
    expect(ended.marked, ended.stderr).toEqual({ t: "marked", name: "session-end" });
    const state = JSON.parse(
      readFileSync(join(dataDir, "logs", "lifecycle-core-state.json"), "utf8"),
    );
    expect(state).toMatchObject({ event: "session-end", clean: false });
    const next = runFakeHost(dataDir, "disconnect");
    expect(next.ready, next.stderr).toBeTruthy();
    const events = readFileSync(join(dataDir, "logs", "lifecycle-core.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event as string);
    expect(events).toContain("previous.session-end");
    expect(events).not.toContain("previous.unclean");
  }, 120_000);

  /** 保持 stdin 打开，直到 core 自己退出——否则 EOF 会抢在父进程校验之前把它关掉。 */
  async function runIntruder(dataDir: string, lines: unknown[]) {
    const child = spawn(join(appDir, APP_LAYOUT.coreExe), [join(appDir, APP_LAYOUT.coreBundle)], {
      env: { ...process.env, ATM_DATA_DIR: dataDir },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    for (const line of lines) child.stdin.write(`${JSON.stringify(line)}${"\n"}`);
    const timer = setTimeout(() => child.kill(), 20_000);
    const status = await new Promise<number | null>((done) => child.once("exit", done));
    clearTimeout(timer);
    child.stdin.destroy();
    return { status, stdout, stderr };
  }
  const intruderHello = {
    t: "hello",
    v: 1,
    runId: "intruder",
    version: "x",
    launch: { background: true, agentWake: false, randomStartupDelay: false },
  };

  it("不是宿主的进程直接拉起 core：父进程校验拒绝（退出码 64），不 listen、不发布 daemon.json、不建数据库", async () => {
    const dataDir = join(work, "data-rejected");
    const child = await runIntruder(dataDir, [intruderHello]);
    expect(child.status).toBe(64);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("ATM_CORE_HOST_UNTRUSTED");
    expect(existsSync(join(dataDir, "runtime", "daemon.json"))).toBe(false);
    expect(existsSync(join(dataDir, "registry"))).toBe(false);
  }, 60_000);

  it("校验完成前就发请求：按协议错误拒绝，同样什么都不建", async () => {
    const dataDir = join(work, "data-early");
    const child = await runIntruder(dataDir, [
      intruderHello,
      { t: "req", id: 1, method: "getMemoryProfile", args: [] },
    ]);
    expect(child.status).toBe(64);
    expect(child.stdout).toBe("");
    expect(existsSync(join(dataDir, "runtime", "daemon.json"))).toBe(false);
    expect(existsSync(join(dataDir, "registry"))).toBe(false);
  }, 60_000);

  it("核心 bundle 不含 electron，也不读 AYANAMI_TASK_TOKEN 以外的用户 token 覆盖", () => {
    const bundle = readFileSync(join(appDir, APP_LAYOUT.coreBundle), "utf8");
    expect(bundle).not.toMatch(/from\s*["']electron["']|require\(["']electron["']\)/u);
    const cli = readFileSync(join(appDir, APP_LAYOUT.cliBundle), "utf8");
    // CLI 入口不带用户代理：没有 host-control 协议、没有 runtimeRequest 代理。
    expect(cli).not.toContain("ATM_RENDERER_PATH_REJECTED");
    expect(cli).not.toContain("HOST_PARENT_UNTRUSTED");
  });
});
