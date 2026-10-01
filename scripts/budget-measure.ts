/**
 * de-electron §2 预算实测（ATM-T-0523b）：在 output/ 下的沙箱里量当前构建。
 *
 *   pnpm exec tsx scripts/budget-measure.ts [--json output/de-electron-budget-raw.json]
 *     [--memory-only]   只量后台与关开窗内存（调内存时反复跑用），不量冷启动
 *     [--cycles N]      关开窗轮数（默认 5）；看有没有缓慢上涨时加大
 *
 * 量什么、怎么量：
 *   - 活动版本净 payload：output/package/app-<version> 递归字节；压缩更新包：zip 字节。
 *   - 后台（无窗口）常驻：生产便携包（portable zip 解到 output/budget-portable）以 --background
 *     拉起，数据根是真实规模样本库的副本；量宿主 + core 的 Private Bytes 与 Working Set。
 *     先空闲量一轮，再用 Agent 凭证打一批读请求（HTTP、定时器、订阅都在跑）后再量一轮。
 *   - 开窗：第二实例发 SHOW（用户再点一次入口），窗口可见后静置再量整棵进程树
 *     （宿主 + core + 本应用的 WebView2 全部进程）；WM_CLOSE 关窗（与点标题栏关闭同一条路径），
 *     等 WebView2 进程全部退出、静置后再量；关开 5 次，看是否回到开窗前的后台水位 ±10%。
 *   - 冷启动（不含 0–5 s 登录随机延迟）：生产包前台启动量 daemon.json 出现、服务健康、窗口可见；
 *     --background 启动量 daemon.json。renderer-ready 与可交互只有 smoke 构建能看（生产包没有
 *     CDP），用 smoke 构建另跑几轮：页内 MutationObserver 记 .atm-shell 挂载（= renderer 报到的
 *     条件）与侧栏项目列表出数据的时刻。
 *
 * 约束：
 *   - 数据根、合成 home、解包目录都在 output/ 下，名字固定；不碰真实安装与真实数据根。
 *   - 进程树用 Toolhelp32 快照，指标只读 Process 的标量属性（PrivateMemorySize64 / WorkingSet64），
 *     不调用 WMI/CIM。
 *   - 只结束自己拉起的宿主：优先经它的 second-instance 管道发 QUIT，不行再按 PID 结束进程树。
 *   - daemon.json 里的 Agent 令牌只在本进程内存里用来发读请求，不写日志、不进报告。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { connect } from "node:net";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";
import { unzipSync } from "fflate";
import Database from "better-sqlite3";
import { AyanamiTaskService } from "../packages/application/src/index.js";
import { NativeWindowProbe } from "./native-window.js";
import {
  assertSandboxDataDir,
  devToolsPortFile,
  exited as childExited,
  killProcessTree,
  outputRoot,
  readDevToolsPort,
  repoRoot,
  runtimeFile,
  smokeExecutable,
  smokeHostEnvironment,
  sourceVersion,
  withLoginItemsRestored,
} from "./smoke-host.js";
import { powershellScratch } from "./powershell-scratch.js";
import {
  BUDGET_PROBE as PROBE,
  buildProcessTree,
  descendantsExited,
  EXITED_STATES,
  requireExitConfirmed,
  treeComplete,
  type ProcessRow,
  type ProcessTree,
  type RawProcessTree,
} from "./budget-probe.js";

const MIB = 1024 * 1024;
const jsonPath = resolve(
  process.argv.includes("--json")
    ? process.argv[process.argv.indexOf("--json") + 1]!
    : join(outputRoot, "de-electron-budget-raw.json"),
);
const coldRuns = Number(
  process.argv.includes("--cold-runs") ? process.argv[process.argv.indexOf("--cold-runs") + 1] : 5,
);
const cycles = Number(
  process.argv.includes("--cycles") ? process.argv[process.argv.indexOf("--cycles") + 1] : 5,
);
const memoryOnly = process.argv.includes("--memory-only");

const seedDir = assertSandboxDataDir(join(outputRoot, "budget-seed-data"));
const runDir = assertSandboxDataDir(join(outputRoot, "budget-run-data"));
const homeDir = assertSandboxDataDir(join(outputRoot, "budget-run-home"));
const portableRoot = assertSandboxDataDir(join(outputRoot, "budget-portable"));
const packageDir = join(outputRoot, "package");

const sleep = (milliseconds: number) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const mib = (bytes: number) => Number((bytes / MIB).toFixed(2));

function directoryBytes(path: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      const nested = directoryBytes(child);
      bytes += nested.bytes;
      files += nested.files;
    } else {
      bytes += statSync(child).size;
      files += 1;
    }
  }
  return { bytes, files };
}

// ---------------------------------------------------------------- 样本库

const SEED = { projects: 100, workItems: 10_000, searchDocuments: 40_000 } as const;

/** 与 scripts/benchmark.ts 同一规模与同一做法：100 个项目、主项目 1 万条任务、4 万条检索文档。 */
async function ensureSeed(): Promise<Record<string, unknown>> {
  const marker = join(seedDir, "budget-seed.json");
  if (existsSync(marker)) return JSON.parse(readFileSync(marker, "utf8"));
  rmSync(seedDir, { recursive: true, force: true });
  mkdirSync(seedDir, { recursive: true });
  const started = performance.now();
  const service = await AyanamiTaskService.open({
    dataDir: seedDir,
    migrationsRoot: join(repoRoot, "migrations"),
  });
  const primary = await service.createProject({ name: "预算基准", sourcePath: null, code: "PFM" });
  for (let index = 1; index < SEED.projects; index += 1)
    await service.createProject({
      name: `预算项目 ${index}`,
      sourcePath: null,
      code: `P${String(index).padStart(3, "0")}`,
    });
  const objective = await service.createObjectiveAsUser(primary.code, "budget-objective", {
    title: "预算基准目标",
    description: "真实规模样本库",
    definitionOfDone: [],
  });
  for (let batch = 0; batch < SEED.workItems / 50; batch += 1)
    await service.createWorkItemsAsUser(
      primary.code,
      `budget-batch-${batch}`,
      Array.from({ length: 50 }, (_, offset) => {
        const index = batch * 50 + offset;
        return {
          clientRef: `budget-${index}`,
          objectiveId: objective.id,
          title: `预算任务 ${String(index).padStart(5, "0")}`,
          description: `真实规模样本任务 ${index}`,
          type: "TASK" as const,
          priority: index % 20 === 0 ? ("HIGH" as const) : ("NORMAL" as const),
          status: index % 3 === 0 ? ("BACKLOG" as const) : ("READY" as const),
          acceptance: [],
          checklist: [],
          verificationRequired: false,
        };
      }),
    );
  service.close();
  const direct = new Database(primary.databasePath);
  direct.pragma("journal_mode = WAL");
  const insertDocument = direct.prepare(
    "INSERT INTO search_documents(entity_type, entity_id, entity_key, title, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertFts = direct.prepare(
    "INSERT INTO search_documents_fts(entity_type, entity_id, entity_key, title, body) VALUES (?, ?, ?, ?, ?)",
  );
  direct.transaction(() => {
    const now = new Date().toISOString();
    for (let index = 0; index < SEED.searchDocuments; index += 1) {
      const id = `budget-document-${index}`;
      const key = `DOC-${index}`;
      const title = `中文预算文档 ${index}`;
      const body = `项目验证关键词 任务管理 本地优先 第 ${index} 条`;
      insertDocument.run("RECORD", id, key, title, body, now);
      insertFts.run("RECORD", id, key, title, body);
    }
  })();
  direct.pragma("wal_checkpoint(TRUNCATE)");
  direct.close();
  const seed = {
    ...SEED,
    seededMs: Math.round(performance.now() - started),
    bytes: directoryBytes(seedDir).bytes,
  };
  writeFileSync(marker, JSON.stringify(seed, null, 2));
  return seed;
}

function freshRunData(keepWebview = false): void {
  const webview = join(runDir, "webview");
  const keep = keepWebview && existsSync(webview);
  for (const entry of existsSync(runDir) ? readdirSync(runDir) : [])
    if (!(keep && entry === "webview"))
      rmSync(join(runDir, entry), { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  cpSync(seedDir, runDir, {
    recursive: true,
    filter: (source) => !source.endsWith("budget-seed.json"),
  });
  // registry 记的是项目库的绝对路径：不改写的话，副本里的服务会去开样本目录里的那些库，
  // 每一轮都改写同一份样本（实测第一版就是这样把备份写进了样本目录）。
  const registry = new Database(join(runDir, "registry", "registry.sqlite"));
  try {
    registry
      .prepare("UPDATE projects SET db_path = replace(db_path, ?, ?)")
      .run(seedDir, resolve(runDir));
    const leaked = registry
      .prepare("SELECT count(*) AS count FROM projects WHERE instr(lower(db_path), lower(?)) > 0")
      .get(seedDir) as { count: number };
    if (leaked.count > 0) throw new Error("副本 registry 仍指向样本目录");
  } finally {
    registry.close();
  }
  rmSync(homeDir, { recursive: true, force: true, maxRetries: 2 });
  mkdirSync(join(homeDir, "Roaming"), { recursive: true });
  mkdirSync(join(homeDir, "Local"), { recursive: true });
}

// ---------------------------------------------------------------- 生产便携包

function ensurePortable(): string {
  const zip = readdirSync(packageDir).find((name) => name.endsWith("-portable.zip"));
  if (!zip) throw new Error(`output/package 里没有便携 zip`);
  const marker = join(portableRoot, "source.json");
  const source = { zip, bytes: statSync(join(packageDir, zip)).size };
  const stale =
    !existsSync(marker) ||
    JSON.stringify(JSON.parse(readFileSync(marker, "utf8"))) !== JSON.stringify(source);
  if (stale) {
    rmSync(portableRoot, { recursive: true, force: true });
    const files = unzipSync(readFileSync(join(packageDir, zip)));
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith("/")) continue;
      const target = join(portableRoot, ...name.split("/"));
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, bytes);
    }
    writeFileSync(marker, JSON.stringify(source));
  }
  const folder = readdirSync(portableRoot).find((name) => name.startsWith("AyanamiTaskManager-"));
  if (!folder) throw new Error("便携 zip 里没有版本目录");
  const executable = join(portableRoot, folder, "AyanamiTaskManager.exe");
  if (!existsSync(join(portableRoot, folder, "portable")))
    throw new Error("便携目录缺 portable 标记");
  return executable;
}

// ---------------------------------------------------------------- 进程探针（Toolhelp32 + 标量）

class ProcessProbe {
  // Add-Type 的编译目录不落 %TEMP%（见 powershell-scratch.ts），进程退出就删。
  private readonly scratch = powershellScratch(repoRoot);
  private readonly child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", PROBE],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: this.scratch.env },
  );
  private readonly waiting: Array<(line: string) => void> = [];
  private queue: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor() {
    // 驱动脚本无论怎么结束都把探针和临时根带走（见 native-window.ts 同一做法）。
    const onDriverExit = () => {
      if (!childExited(this.child)) this.child.kill();
      this.scratch.dispose();
    };
    process.once("exit", onDriverExit);
    const onProbeGone = () => {
      process.removeListener("exit", onDriverExit);
      this.scratch.dispose();
    };
    this.child.once("exit", onProbeGone);
    this.child.once("error", onProbeGone);
    const lines = createInterface({ input: this.child.stdout });
    let first: (() => void) | null = null;
    this.ready = new Promise((done) => (first = done));
    lines.on("line", (line) => {
      if (first && line === "ready") {
        first();
        first = null;
        return;
      }
      this.waiting.shift()?.(line);
    });
  }

  private ask(command: string): Promise<string> {
    const next = this.queue.then(
      () =>
        new Promise<string>((done) => {
          this.waiting.push(done);
          this.child.stdin.write(`${command}\n`);
        }),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * 以 pid 为根的进程树（判定见 buildProcessTree）：查不了身份的列在 unknown、读不到内存的
   * 列在 unmeasured，不悄悄丢掉。整次查询失败抛错，不当成空树。
   */
  async tree(pid: number): Promise<ProcessTree> {
    const line = await this.ask(`tree ${pid}`);
    if (line === "null") throw new Error(`进程树查询失败：${pid}`);
    return buildProcessTree(JSON.parse(line) as RawProcessTree, pid);
  }

  /**
   * 用来量内存的树：有查不了身份或读不到内存的成员就不出样本，免得少算。快照前后刚好有进程
   * 出生会被记成查不了，短暂重试几次。
   */
  async measuredTree(pid: number): Promise<ProcessRow[]> {
    for (let attempt = 1; ; attempt += 1) {
      const tree = await this.tree(pid);
      if (treeComplete(tree) && tree.unmeasured.length === 0) return tree.rows;
      if (attempt >= 3)
        throw new Error(
          `进程树查不全，样本不可信：unknown ${tree.unknown.join(",")}; unmeasured ${tree.unmeasured.join(",")}`,
        );
      await sleep(200);
    }
  }

  async close(hwnd: number): Promise<boolean> {
    return (await this.ask(`close ${hwnd}`)) === "true";
  }

  /** 记下的进程是否还在：same / gone / other / unknown。 */
  async alive(row: { pid: number; ticks: string }): Promise<string> {
    return this.ask(`alive ${row.pid} ${row.ticks}`);
  }

  /** 只在 PID 上仍是记下的那个进程时结束它（同一句柄上核对并结束）。 */
  async killSame(row: { pid: number; ticks: string }): Promise<string> {
    return this.ask(`killsame ${row.pid} ${row.ticks}`);
  }

  async session(pid: number): Promise<number> {
    return Number(await this.ask(`session ${pid}`));
  }

  stop(): void {
    this.child.stdin.end();
  }
}

type Sample = {
  atMs: number;
  processes: number;
  webview2: number;
  hostCorePrivate: number;
  hostCoreWs: number;
  totalPrivate: number;
  totalWs: number;
  rows?: ProcessRow[];
};

function summarize(rows: ProcessRow[], hostPid: number, keepRows = false): Sample {
  const hostCore = rows.filter(
    (row) =>
      row.pid === hostPid || (row.ppid === hostPid && row.exe.toLowerCase() === "atm-core.exe"),
  );
  const sum = (list: ProcessRow[], key: "ws" | "priv") =>
    list.reduce((total, row) => total + row[key], 0);
  return {
    atMs: Date.now(),
    processes: rows.length,
    webview2: rows.filter((row) => row.exe.toLowerCase() === "msedgewebview2.exe").length,
    hostCorePrivate: sum(hostCore, "priv"),
    hostCoreWs: sum(hostCore, "ws"),
    totalPrivate: sum(rows, "priv"),
    totalWs: sum(rows, "ws"),
    ...(keepRows ? { rows } : {}),
  };
}

async function sampleSeries(
  probe: ProcessProbe,
  hostPid: number,
  count: number,
  intervalMs: number,
): Promise<{ samples: Sample[]; median: Omit<Sample, "atMs" | "rows"> }> {
  const samples: Sample[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index > 0) await sleep(intervalMs);
    samples.push(summarize(await probe.measuredTree(hostPid), hostPid, index === count - 1));
  }
  const pick = (key: keyof Omit<Sample, "atMs" | "rows">) =>
    median(samples.map((sample) => sample[key]));
  return {
    samples,
    median: {
      processes: pick("processes"),
      webview2: pick("webview2"),
      hostCorePrivate: pick("hostCorePrivate"),
      hostCoreWs: pick("hostCoreWs"),
      totalPrivate: pick("totalPrivate"),
      totalWs: pick("totalWs"),
    },
  };
}

// ---------------------------------------------------------------- 宿主驱动

type Host = { child: ChildProcess; pid: number; executable: string; env: NodeJS.ProcessEnv };

function startHost(executable: string, args: string[]): Host {
  const env = smokeHostEnvironment(runDir, homeDir);
  const child = spawn(executable, args, { cwd: repoRoot, env, windowsHide: true, stdio: "ignore" });
  if (child.pid === undefined) throw new Error(`宿主没能启动：${executable}`);
  return { child, pid: child.pid, executable, env };
}

/** 有界轮询（只在这一个点上等）：read 返回非 null 即成功。 */
async function until<T>(
  read: () => Promise<T | null> | T | null,
  timeoutMs: number,
  label: string,
  intervalMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`等待${label}超时（${timeoutMs}ms）`);
    await sleep(intervalMs);
  }
}

async function healthy(): Promise<{ token: string; endpoint: string; pid: number } | null> {
  if (!existsSync(runtimeFile(runDir))) return null;
  try {
    const runtime = JSON.parse(readFileSync(runtimeFile(runDir), "utf8")) as {
      token: string;
      endpoint: string;
      pid: number;
    };
    const response = await fetch(`${runtime.endpoint}/api/v1/system/status`, {
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    return response.ok ? runtime : null;
  } catch {
    return null;
  }
}

/** 宿主 second-instance 管道名（与 install-state/src/ipc.rs pipe_name 同一规则）。 */
function pipeName(sessionId: number): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(resolve(runDir).toLowerCase(), "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const user = (process.env.USERNAME ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "")
    .slice(0, 32);
  return `\\\\.\\pipe\\AyanamiTaskManager.Host.${user}.${sessionId}.${hash.toString(16).padStart(16, "0")}`;
}

function sendPipe(name: string, command: object): Promise<string> {
  return new Promise((done) => {
    const socket = connect(name);
    let reply = "";
    const timer = setTimeout(() => {
      socket.destroy();
      done("timeout");
    }, 5_000);
    socket.on("connect", () => socket.write(JSON.stringify(command)));
    socket.on("data", (chunk) => (reply += chunk.toString("utf8")));
    socket.on("error", (error) => {
      clearTimeout(timer);
      done(`error: ${error.message}`);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      done(reply);
    });
  });
}

const exited = (host: Host, timeoutMs: number) =>
  childExited(host.child)
    ? Promise.resolve(true)
    : Promise.race([
        new Promise<boolean>((done) => host.child.once("exit", () => done(true))),
        sleep(timeoutMs).then(() => false),
      ]);

/** 优雅退出：生产构建没有 --smoke-quit，走 setup 用的那条 QUIT 管道命令；不行才按 PID 结束进程树。 */
async function quitHost(
  host: Host,
  probe: ProcessProbe,
): Promise<{
  graceful: boolean;
  reply: string;
  /** 确认了宿主的整棵子孙树都已退出（见 descendantsExited）。 */
  confirmed: boolean;
  descendantsGoneMs: number | null;
  descendantsUnknown: number;
  treeFailed: boolean;
}> {
  // 宿主在收尾前就自己退出了：子孙树已经没法从它查起，不能确认。
  if (childExited(host.child))
    return {
      graceful: false,
      reply: "already-exited",
      confirmed: false,
      descendantsGoneMs: null,
      descendantsUnknown: 0,
      treeFailed: true,
    };
  // 先记下整棵树：宿主退出后 WebView2 浏览器进程可能还要一会儿才走，下一轮不能和它共用用户数据目录。
  // 出生时间与树成员身份一起取：之后只认 PID 上仍是这个进程的，PID 被复用给别人时不碰它。
  // 树查不全（整次失败，或有候选——包括根——查不了身份）就不能声称子孙都已退出：如实报告。
  const tree = await probe.tree(host.pid).catch(() => null);
  const descendants = (tree?.rows ?? []).filter((row) => row.pid !== host.pid);
  const reply = await sendPipe(pipeName(await probe.session(host.pid)), { cmd: "QUIT" });
  const graceful = await exited(host, 20_000);
  if (!graceful) {
    killProcessTree(host.pid);
    await exited(host, 5_000);
  }
  const quitAt = Date.now();
  let states: string[] = [];
  const left = await until(
    async () => {
      states = await Promise.all(descendants.map((row) => probe.alive(row)));
      // 只有明确 gone / other 才算走了；same 与查不了的都等，最后如实报告。
      return states.every((state) => EXITED_STATES.has(state)) ? true : null;
    },
    15_000,
    "宿主的子孙进程退出",
    50,
  ).catch(() => false);
  if (!left) for (const row of descendants) await probe.killSame(row);
  const confirmed = descendantsExited(tree, states);
  return {
    graceful: graceful && confirmed,
    reply,
    confirmed,
    descendantsGoneMs: confirmed ? Date.now() - quitAt : null,
    // 查不了身份的个数：快照时就查不了的候选，加上最后一轮仍查不了的子孙。
    descendantsUnknown:
      (tree?.unknown.length ?? 0) +
      states.filter((state) => state !== "same" && !EXITED_STATES.has(state)).length,
    treeFailed: tree === null,
  };
}

async function requestShow(host: Host): Promise<void> {
  const show = spawn(host.executable, [], {
    cwd: repoRoot,
    env: host.env,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((done) => show.once("exit", () => done()));
}

// ---------------------------------------------------------------- 各项测量

async function measureMemory(executable: string, probe: ProcessProbe, windows: NativeWindowProbe) {
  freshRunData();
  const host = startHost(executable, ["--background"]);
  try {
    const runtime = await until(healthy, 60_000, "服务健康", 100);
    // 起来之后先空着：首轮维护（2.5 s）、订阅、更新检查都跑过一遍。
    await sleep(30_000);
    const idle = await sampleSeries(probe, host.pid, 5, 2_000);

    // Agent 读流量：概览、项目列表、大项目分页、中文检索、增量。
    const auth = { authorization: `Bearer ${runtime.token}` };
    const paths = [
      "/api/v1/overview",
      "/api/v1/projects",
      "/api/v1/projects/PFM/work-items?status=READY&limit=100&offset=4000",
      `/api/v1/projects/PFM/search?query=${encodeURIComponent("项目验证关键词")}&limit=20`,
      "/api/v1/projects/PFM/events?since=0&limit=100",
      "/api/v1/system/status",
    ];
    const statuses: Record<string, number> = {};
    for (let round = 0; round < 10; round += 1)
      for (const path of paths) {
        const response = await fetch(`${runtime.endpoint}${path}`, { headers: auth });
        await response.arrayBuffer();
        statuses[path] = response.status;
      }
    await sleep(15_000);
    const afterAgent = await sampleSeries(probe, host.pid, 5, 2_000);

    const cyclesOut: Array<Record<string, unknown>> = [];
    for (let cycle = 0; cycle <= cycles; cycle += 1) {
      const showAt = Date.now();
      await requestShow(host);
      const visible = await until(
        async () => {
          const state = await windows.appWindow(host.pid);
          return state?.visible ? state : null;
        },
        30_000,
        "窗口可见",
        50,
      );
      const visibleMs = Date.now() - showAt;
      await sleep(10_000);
      const open = await sampleSeries(probe, host.pid, 3, 2_000);
      const closeAt = Date.now();
      await probe.close(visible.hwnd);
      await until(
        async () => {
          const tree = await probe.tree(host.pid);
          // 查不了的成员可能正是 WebView2：等它。
          if (tree.unknown.length > 0) return null;
          return tree.rows.some((row) => row.exe.toLowerCase() === "msedgewebview2.exe")
            ? null
            : tree.rows;
        },
        30_000,
        "WebView2 进程退出",
        100,
      );
      const webviewGoneMs = Date.now() - closeAt;
      await sleep(10_000);
      const closed = await sampleSeries(probe, host.pid, 3, 2_000);
      cyclesOut.push({ cycle, visibleMs, webviewGoneMs, open, closed });
    }
    // core 自己每分钟记一次 rss/heapUsed（core-main.ts heartbeat）：用来区分 V8 堆与堆外增长。
    const lifecycle = join(runDir, "logs", "lifecycle-core.ndjson");
    const heartbeats = existsSync(lifecycle)
      ? readFileSync(lifecycle, "utf8")
          .split(/\r?\n/u)
          .filter((line) =>
            /"event":"(?:heartbeat|window\.shown|window\.closed|window\.released)"/u.test(line),
          )
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    return {
      statuses,
      idle,
      afterAgent,
      cycles: cyclesOut,
      heartbeats,
      quit: await quitHost(host, probe),
    };
  } finally {
    if (!childExited(host.child)) killProcessTree(host.pid);
  }
}

/** 生产包冷启动：spawn → daemon.json 出现 → 服务健康 → 窗口可见（前台启动时）。 */
async function coldStartProduction(
  executable: string,
  probe: ProcessProbe,
  windows: NativeWindowProbe,
  background: boolean,
) {
  const host = startHost(executable, background ? ["--background"] : []);
  const started = performance.now();
  try {
    const daemonJson = await until(
      () => (existsSync(runtimeFile(runDir)) ? performance.now() - started : null),
      30_000,
      "daemon.json",
      10,
    );
    await until(healthy, 30_000, "服务健康", 10);
    const health = performance.now() - started;
    let visible: number | null = null;
    if (!background) {
      await until(
        async () => ((await windows.appWindow(host.pid))?.visible ? true : null),
        30_000,
        "窗口可见",
        25,
      );
      visible = performance.now() - started;
    }
    await sleep(3_000);
    return {
      daemonJsonMs: Math.round(daemonJson),
      healthMs: Math.round(health),
      windowVisibleMs: visible === null ? null : Math.round(visible),
      quit: await quitHost(host, probe),
    };
  } finally {
    if (!childExited(host.child)) killProcessTree(host.pid);
  }
}

/**
 * smoke 构建冷启动：同上，再经 CDP 记 renderer-ready（.atm-shell 挂载，renderer.tsx 的报到条件）
 * 与可交互（侧栏「活动项目」出了项目按钮，即首批数据已渲染，且窗口可见）。
 * 页面里的时刻用 Date.now()，与本进程同一个系统时钟。
 */
async function coldStartSmoke(executable: string, probe: ProcessProbe, windows: NativeWindowProbe) {
  rmSync(devToolsPortFile(runDir), { force: true });
  const host = startHost(executable, []);
  const startedWall = Date.now();
  const started = performance.now();
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    const daemonJson = await until(
      () => (existsSync(runtimeFile(runDir)) ? performance.now() - started : null),
      30_000,
      "daemon.json",
      10,
    );
    const port = await until(() => readDevToolsPort(runDir), 30_000, "DevTools 端口", 10);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const connectedWall = Date.now();
    const page = await until(
      () =>
        browser!
          .contexts()
          .flatMap((context) => context.pages())
          .find((candidate) => candidate.url().startsWith("https://atm.localhost")) ?? null,
      30_000,
      "页面",
      20,
    );
    await page.evaluate(`(() => {
      const marks = (window.__budgetMarks = { installedAt: Date.now(), shell: null, data: null, shellAlready: false, dataAlready: false });
      const check = () => {
        if (marks.shell === null && document.querySelector(".atm-shell")) marks.shell = Date.now();
        if (marks.data === null && document.querySelector('nav[aria-label="活动项目"] button')) marks.data = Date.now();
        return marks.shell !== null && marks.data !== null;
      };
      if (document.querySelector(".atm-shell")) marks.shellAlready = true;
      if (document.querySelector('nav[aria-label="活动项目"] button')) marks.dataAlready = true;
      if (check()) return;
      const observer = new MutationObserver(() => { if (check()) observer.disconnect(); });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    })()`);
    await until(
      async () => ((await windows.appWindow(host.pid))?.visible ? true : null),
      30_000,
      "窗口可见",
      25,
    );
    const visibleWall = Date.now();
    await page.waitForFunction(
      () => {
        const marks = (
          window as unknown as { __budgetMarks?: { shell: number | null; data: number | null } }
        ).__budgetMarks;
        return Boolean(marks && marks.shell !== null && marks.data !== null);
      },
      undefined,
      { timeout: 30_000 },
    );
    const marks = (await page.evaluate("window.__budgetMarks")) as {
      installedAt: number;
      shell: number;
      data: number;
      shellAlready: boolean;
      dataAlready: boolean;
    };
    return {
      daemonJsonMs: Math.round(daemonJson),
      cdpConnectedMs: connectedWall - startedWall,
      windowVisibleMs: visibleWall - startedWall,
      rendererReadyMs: marks.shell - startedWall,
      rendererReadyUpperBound: marks.shellAlready,
      dataRenderedMs: marks.data - startedWall,
      interactiveMs: Math.max(marks.data, visibleWall) - startedWall,
      interactiveUpperBound: marks.dataAlready,
      quit: await quitHost(host, probe),
    };
  } finally {
    await browser?.close().catch(() => undefined);
    if (!childExited(host.child)) killProcessTree(host.pid);
  }
}

// ---------------------------------------------------------------- 主流程

const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  version: sourceVersion,
  machine: {
    cpus: (await import("node:os")).cpus().length,
    totalMemMiB: Math.round((await import("node:os")).totalmem() / MIB),
  },
};
const save = () => writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const appDir = join(packageDir, `app-${sourceVersion}`);
const payload = directoryBytes(appDir);
const updateZip = readdirSync(packageDir).find((name) => /^atm-.*-win-x64\.zip$/u.test(name))!;
const portableZip = readdirSync(packageDir).find((name) => name.endsWith("-portable.zip"))!;
report.sizes = {
  appDir,
  payloadBytes: payload.bytes,
  payloadMiB: mib(payload.bytes),
  payloadFiles: payload.files,
  updateZip,
  updateZipBytes: statSync(join(packageDir, updateZip)).size,
  updateZipMiB: mib(statSync(join(packageDir, updateZip)).size),
  portableZip,
  portableZipBytes: statSync(join(packageDir, portableZip)).size,
  setupExeBytes: existsSync(join(packageDir, "atm-setup.exe"))
    ? statSync(join(packageDir, "atm-setup.exe")).size
    : null,
};
save();

report.seed = await ensureSeed();
const production = ensurePortable();
const smoke = smokeExecutable();
report.executables = { production, smoke };
save();

const probe = new ProcessProbe();
let windows: NativeWindowProbe | null = null;
try {
  await probe.ready;
  windows = NativeWindowProbe.start();
  const nativeWindows = windows;
  await nativeWindows.windows(process.pid);
  await withLoginItemsRestored(async () => {
    const memory = await measureMemory(production, probe, nativeWindows);
    report.memory = memory;
    save();
    requireExitConfirmed("内存测量", memory.quit);
    if (memoryOnly) return;

    const production_foreground = [];
    const production_background = [];
    // 第一轮带着刚才那次运行留下的 WebView2 用户数据目录，和用户日常登录一致。
    for (let run = 0; run < coldRuns; run += 1) {
      freshRunData(true);
      const result = await coldStartProduction(production, probe, nativeWindows, false);
      production_foreground.push(result);
      report.coldStartProduction = { foreground: production_foreground };
      save();
      requireExitConfirmed(`前台冷启动第 ${run + 1} 轮`, result.quit);
    }
    for (let run = 0; run < coldRuns; run += 1) {
      freshRunData(true);
      const result = await coldStartProduction(production, probe, nativeWindows, true);
      production_background.push(result);
      report.coldStartProduction = {
        foreground: production_foreground,
        background: production_background,
      };
      save();
      requireExitConfirmed(`后台冷启动第 ${run + 1} 轮`, result.quit);
    }
    report.coldStartProduction = {
      foreground: production_foreground,
      background: production_background,
    };
    save();

    const smokeRuns = [];
    for (let run = 0; run < Math.min(coldRuns, 3); run += 1) {
      freshRunData(true);
      const result = await coldStartSmoke(smoke, probe, nativeWindows);
      smokeRuns.push(result);
      report.coldStartSmoke = smokeRuns;
      save();
      requireExitConfirmed(`smoke 冷启动第 ${run + 1} 轮`, result.quit);
    }
    report.coldStartSmoke = smokeRuns;
  }, [production, smoke]);
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  probe.stop();
  windows?.close();
  report.completedAt = new Date().toISOString();
  save();
}
process.stdout.write(`${jsonPath}\n`);
if (report.error) {
  process.stderr.write(`${String(report.error)}\n`);
  process.exitCode = 1;
}
