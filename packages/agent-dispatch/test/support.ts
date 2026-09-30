import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentDispatcher,
  type AgentDispatcherOptions,
  type DispatchHost,
  type DispatchLogger,
  type DispatchProject,
  type DispatchTask,
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
  behave(mode: "success" | "fail" | "error-result" | "slow", delayMs?: number): void;
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
      const dispatcher = new AgentDispatcher({
        dataDir,
        host,
        resolveClaude: () => FAKE_CLAUDE,
        logger,
        pollIntervalMs: 50,
        ...options,
      });
      dispatchers.push(dispatcher);
      return dispatcher;
    },
  };
  return self;
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
