import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  AgentDispatcher,
  type AgentDispatcherOptions,
  type DispatchHost,
  type DispatchLogger,
  type DispatchProject,
  type DispatchSpawn,
  type DispatchTask,
  type KillResult,
} from "../src/index.js";

export const FAKE_CLAUDE = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures",
  "fake-claude.mjs",
);

const temporary: string[] = [];
const dispatchers: AgentDispatcher[] = [];

/** afterEach 调：结束仍在跑的假会话、关掉调度器、删临时目录（Windows 上 cwd 被占用的目录删不掉）。 */
export async function cleanupAll(): Promise<void> {
  for (const dispatcher of dispatchers.splice(0)) {
    for (const run of dispatcher.listRuns()) {
      if (run.state === "queued" || run.state === "running")
        await dispatcher.cancel(run.run).catch(() => undefined);
    }
    dispatcher.close();
  }
  await new Promise((done) => setTimeout(done, 100));
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export type Fixture = {
  root: string;
  dataDir: string;
  projectDir: string;
  host: DispatchHost & {
    projects: Map<string, DispatchProject>;
    tasks: Map<string, DispatchTask>;
  };
  warnings: string[];
  logger: DispatchLogger;
  behave(
    mode: "success" | "fail" | "error-result" | "auth-stderr" | "api-error" | "slow",
    delayMs?: number,
  ): void;
  addTask(key: string, patch?: Partial<DispatchTask>): DispatchTask;
  dump(run: string): {
    args: string[];
    stdin: string;
    cwd: string;
    envNames: string[];
    env: Record<string, string | null>;
    pid: number;
  };
  dispatcher(options?: Partial<AgentDispatcherOptions>): AgentDispatcher;
};

export function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "atm-dispatch-test-"));
  temporary.push(root);
  const dataDir = join(root, "data");
  const projectDir = join(root, "project");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const projects = new Map<string, DispatchProject>([
    ["DEMO", { code: "DEMO", name: "演示项目", paths: [projectDir] }],
  ]);
  const tasks = new Map<string, DispatchTask>();
  const warnings: string[] = [];
  const logger: DispatchLogger = {
    info() {},
    warn(message) {
      warnings.push(message);
    },
    error(message) {
      warnings.push(message);
    },
  };
  const host = {
    projects,
    tasks,
    getProject: (code: string) => projects.get(code) ?? null,
    getTask: (_code: string, key: string) => tasks.get(key) ?? null,
  };
  const self: Fixture = {
    root,
    dataDir,
    projectDir,
    host,
    warnings,
    logger,
    behave(mode, delayMs) {
      writeFileSync(
        join(projectDir, "fake-claude.json"),
        JSON.stringify({ mode, ...(delayMs === undefined ? {} : { delayMs }) }),
      );
    },
    addTask(key, patch = {}) {
      const task: DispatchTask = {
        key,
        title: `任务 ${key}`,
        status: "READY",
        description: "",
        claimedBySessionId: null,
        claimLeaseUntil: null,
        ...patch,
      };
      tasks.set(key, task);
      return task;
    },
    dump(run) {
      return JSON.parse(readFileSync(join(projectDir, `fake-claude-dump-${run}.json`), "utf8"));
    },
    dispatcher(options = {}) {
      // 进程相关的系统调用一律换成替身：只认这个夹具自己 spawn 出来的子进程，结束时走它的句柄
      // （child.kill()），绝不对别的 PID 发信号；出生标识按 PID 编，不起 PowerShell、不读 /proc。
      const inner = options.spawnImpl ?? spawn;
      const spawnImpl: DispatchSpawn = (command, args, spawnOptions) => {
        const child = inner(command, args, spawnOptions);
        if (child.pid !== undefined) own.set(child.pid, child);
        return child;
      };
      const ownAlive = (pid: number) => {
        const child = own.get(pid);
        return child !== undefined && child.exitCode === null && child.signalCode === null;
      };
      const dispatcher = new AgentDispatcher({
        dataDir,
        host,
        resolveClaude: () => FAKE_CLAUDE,
        logger,
        pollIntervalMs: 50,
        processIdentity: async (pid) => (own.has(pid) ? `test:${pid}` : null),
        isPidAlive: ownAlive,
        killProcessTree: async (pid): Promise<KillResult> => {
          if (!ownAlive(pid)) return { kind: "gone" };
          own.get(pid)!.kill();
          return { kind: "killed" };
        },
        ...options,
        spawnImpl,
      });
      dispatchers.push(dispatcher);
      return dispatcher;
    },
  };
  const own = new Map<number, ChildProcess>();
  return self;
}

/**
 * 与 Windows 默认探测同形的出生标识：`win32:<FILETIME>`（1601 年起的 100ns 计数）。
 * `extraTicks` 是在毫秒之外再加的 100ns 刻度，用来造「只差一点点」的不同进程。
 */
export function winIdentity(at: Date, extraTicks = 0n): string {
  const ticks = (BigInt(at.getTime()) + 11_644_473_600_000n) * 10_000n + extraTicks;
  return `win32:${ticks}`;
}

/** 不起真进程的子进程替身：有 PID、stdin、exit 事件；`finish` 模拟进程退出。 */
export type FakeChild = ChildProcess & { finish(code: number | null): void };

export function fakeChild(pid: number, onExit: () => void = () => {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  const fields = { pid, exitCode: null, signalCode: null, stdin: new PassThrough() };
  Object.assign(child, fields, {
    unref() {},
    kill() {
      throw new Error("替身子进程不应被直接 kill");
    },
    finish(code: number | null) {
      if ((child as { exitCode: number | null }).exitCode !== null) return;
      Object.assign(child, { exitCode: code });
      onExit();
      child.emit("exit", code, null);
    },
  });
  return child;
}

let nextFakePid = 4_100_000;

/**
 * 一套进程替身：`spawnImpl` 造 {@link FakeChild}；`alive` 是「系统里活着的 PID」，`identities` 是各 PID 的出生标识
 * （没有 = 查不到）；`killProcessTree` 只记下调用并按 `killResult` 回答，默认让对应替身退出。
 * 残留/接管类用例直接往 `alive`、`identities` 里放 PID，用不到任何真实进程。
 */
export function fakeProcesses() {
  const children: FakeChild[] = [];
  const alive = new Set<number>();
  const identities = new Map<number, string>();
  const kills: number[] = [];
  const control: { killResult: KillResult | null } = { killResult: null };
  const spawnImpl: DispatchSpawn = () => {
    const pid = nextFakePid;
    nextFakePid += 4;
    const child = fakeChild(pid, () => alive.delete(pid));
    alive.add(pid);
    identities.set(pid, winIdentity(new Date(Date.UTC(2026, 8, 1, 0, 0, children.length))));
    children.push(child);
    return child;
  };
  const options = {
    spawnImpl,
    isPidAlive: (pid: number) => alive.has(pid),
    processIdentity: async (pid: number) => identities.get(pid) ?? null,
    killProcessTree: async (pid: number): Promise<KillResult> => {
      kills.push(pid);
      if (control.killResult) return control.killResult;
      if (!alive.has(pid)) return { kind: "gone" };
      alive.delete(pid);
      const child = children.find((candidate) => candidate.pid === pid);
      // 真进程的 exit 事件总在结束命令返回之后才到。
      if (child) setImmediate(() => child.finish(1));
      return { kind: "killed" };
    },
  } satisfies Partial<AgentDispatcherOptions>;
  return { children, alive, identities, kills, control, options };
}

export async function waitFor<T>(
  probe: () => T | null | undefined | false,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((done) => setTimeout(done, 25));
  }
}

export function dumpExists(projectDir: string, run: string): boolean {
  return existsSync(join(projectDir, `fake-claude-dump-${run}.json`));
}
