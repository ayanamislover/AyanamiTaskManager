/**
 * 3.0 预算实测（ATM 3 规格 08：协议 §1、验收线 §3）：在 output/ 下的沙箱里量当前构建。
 *
 *   pnpm exec tsx scripts/budget-measure.ts [--json output/budget-report.json]
 *     [--memory-only]   只量首次转换与内存（调内存时反复跑用），不量冷启动
 *     [--cycles N]      关开窗轮数（默认 5）；看有没有缓慢上涨时加大
 *     [--cold-runs N]   生产包前台、后台冷启动各几轮（默认 5；smoke 取 min(N, 3)）
 *
 * 量什么、怎么量：
 *   - 体积：output/package/app-<version> 递归字节（payload）、更新 zip、便携 zip、atm-setup.exe。
 *   - 首次转换：2.x 根 L 是真实规模样本库的副本，N 空着，生产便携包 --background 拉起；量 spawn →
 *     服务健康，期间轮询 N\runtime\startup-progress.json 记下每一次推进（「有进度」）。转换完成、
 *     宿主退出后，把 L 与 N 存成快照；之后每一轮都从这份快照开始——冷启动不含首次转换（08 §3）。
 *   - 内存（主进程 Private Bytes 为主、Working Set 为辅；WebView2 树单独报）：每个场景静置 ≥10 s，
 *     每 2 s 采一次、共 5 次，取中位数。场景：后台空闲；Agent 负载之后（项目列表、brief、深分页、
 *     中文检索、events、system/status，都是 Agent HTTP 上的 3.x 路由）；开窗稳定；关窗后（WebView2
 *     进程全部退出再静置）；关开窗 N 轮。导出一个大项目之后（导出只给用户，走界面的 bridge）用
 *     smoke 构建单独量。
 *   - 冷启动（不含 0–5 s 登录随机延迟）：生产包前台 N 轮记 daemon.json 出现、服务健康、窗口可见；
 *     --background N 轮记服务健康；smoke 构建 3 轮经 CDP 记 renderer-ready（.atm-shell 挂载）与
 *     可交互（侧栏项目列表出数据且窗口可见）。报中位数与最大值。
 *   - 判定：summary.verdicts 逐条对 08 §3 的验收线；有一条不达标就以退出码 1 结束（预算不放宽，
 *     除非用户同意）。
 *
 * 约束：
 *   - 数据根、合成 home、解包目录都在 output/ 下，名字固定；不碰真实安装与真实数据根。
 *   - 进程树用 Toolhelp32 快照，指标只读 Process 的标量属性（PrivateMemorySize64 / WorkingSet64），
 *     不调用 WMI/CIM。
 *   - 只结束自己拉起的宿主：优先经它的 second-instance 管道发 QUIT，不行再按 PID 结束进程树。
 *   - daemon.json 里的 Agent 令牌只在本进程内存里用来发读请求，不写日志、不进报告。
 */
// 先于一切：这里拉起的宿主窗口不抢焦点、压在最底层（scripts/test-windows.ts）。
import "./test-windows.js";
import { agentFetch } from "./agent-fetch.js";
import { binariesOf } from "./candidate-binaries.js";
import { budgetVerdicts, stats } from "./budget-verdicts.js";
import { rendererRequest } from "./renderer-user-request.js";
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
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";
import { copySampleLibrary, ensureSampleLibrary } from "./sample-library.js";
import { unpackPortable } from "./portable-unpack.js";
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
  v3Root,
  withLoginItemsRestored,
} from "./smoke-host.js";
import { powershellScratch } from "./powershell-scratch.js";
import {
  BUDGET_PROBE as PROBE,
  buildProcessTree,
  quitConfirmed,
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
/** 首次转换完成时的 L 与 N：冷启动与内存的每一轮都从这里恢复。 */
const convertedLDir = assertSandboxDataDir(join(outputRoot, "budget-converted-data"));
const convertedNDir = assertSandboxDataDir(join(outputRoot, "budget-converted-n"));
/** 3.0 根 N（smokeHostEnvironment 把 ATM3_DATA_DIR 指到这里）：运行文件、WebView 数据与 lifecycle 日志。 */
const v3Dir = v3Root(homeDir);
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

/** 首次转换用的数据：L 换回样本副本，N 清空。 */
function freshRunData(): void {
  copySampleLibrary(seedDir, runDir);
  resetHome(false);
}

/** 转换完成、宿主退出之后：L 与 N 存成快照（N 的运行文件、WebView 数据与日志不进快照）。 */
function snapshotConverted(): void {
  if (!existsSync(join(v3Dir, "conversion.json")))
    throw new Error("N 里没有 conversion.json：转换没完成");
  rmSync(convertedLDir, { recursive: true, force: true, maxRetries: 2 });
  cpSync(runDir, convertedLDir, { recursive: true });
  const transient = ["runtime", "webview", "logs"].map((name) => join(v3Dir, name).toLowerCase());
  rmSync(convertedNDir, { recursive: true, force: true, maxRetries: 2 });
  cpSync(v3Dir, convertedNDir, {
    recursive: true,
    filter: (source) => !transient.includes(source.toLowerCase()),
  });
}

/**
 * 冷启动与内存的每一轮：L 与 N 换回首次转换完成时的快照，冷启动就不含首次转换（08 §3）。
 * keepWebview 时留下 N\webview（和用户日常登录一样，WebView2 的用户数据目录已经在）。
 * 两份快照都在同一组固定路径上转出来，里面记的绝对路径原样可用。
 */
function convertedRunData(keepWebview = false): void {
  if (!existsSync(join(convertedNDir, "conversion.json")))
    throw new Error("没有转换后的快照：先量首次转换");
  rmSync(runDir, { recursive: true, force: true, maxRetries: 2 });
  cpSync(convertedLDir, runDir, { recursive: true });
  resetHome(keepWebview);
  cpSync(convertedNDir, v3Dir, { recursive: true });
}

/** 合成 home 清空（keepWebview 时只留 N\webview）。 */
function resetHome(keepWebview: boolean): void {
  const keep = keepWebview && existsSync(join(v3Dir, "webview"));
  const clear = (dir: string, except: string | null) => {
    for (const entry of existsSync(dir) ? readdirSync(dir) : [])
      if (entry !== except)
        rmSync(join(dir, entry), { recursive: true, force: true, maxRetries: 2 });
  };
  if (keep) {
    clear(homeDir, "Local");
    clear(join(homeDir, "Local"), basename(v3Dir));
    clear(v3Dir, "webview");
  } else rmSync(homeDir, { recursive: true, force: true, maxRetries: 2 });
  mkdirSync(join(homeDir, "Roaming"), { recursive: true });
  mkdirSync(join(homeDir, "Local"), { recursive: true });
}

// ---------------------------------------------------------------- 生产便携包

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
  hostPrivate: number;
  hostWs: number;
  totalPrivate: number;
  totalWs: number;
  rows?: ProcessRow[];
};

function summarize(rows: ProcessRow[], hostPid: number, keepRows = false): Sample {
  // 3.x 单进程：服务在宿主里，没有 core 子进程。
  const host = rows.filter((row) => row.pid === hostPid);
  const sum = (list: ProcessRow[], key: "ws" | "priv") =>
    list.reduce((total, row) => total + row[key], 0);
  return {
    atMs: Date.now(),
    processes: rows.length,
    webview2: rows.filter((row) => row.exe.toLowerCase() === "msedgewebview2.exe").length,
    hostPrivate: sum(host, "priv"),
    hostWs: sum(host, "ws"),
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
      hostPrivate: pick("hostPrivate"),
      hostWs: pick("hostWs"),
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
  if (!existsSync(runtimeFile(v3Dir))) return null;
  try {
    const runtime = JSON.parse(readFileSync(runtimeFile(v3Dir), "utf8")) as {
      token: string;
      endpoint: string;
      pid: number;
    };
    const response = await agentFetch(`${runtime.endpoint}/api/v1/system/status`, {
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
  /** 宿主自己最终退出了（优雅退出，或强制结束后确实退出）。 */
  hostGone: boolean;
  /** 宿主与整棵子孙树都确认已退出（见 quitConfirmed）。 */
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
      hostGone: true,
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
  let hostGone = graceful;
  if (!graceful) {
    killProcessTree(host.pid);
    hostGone = await exited(host, 5_000);
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
  const confirmed = quitConfirmed({ hostGone, tree, states });
  return {
    graceful: graceful && confirmed,
    reply,
    hostGone,
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

/** WM_CLOSE 关窗（与点标题栏关闭同一条路径），等本应用的 WebView2 进程全部退出；返回用了多久。 */
async function closeWindow(probe: ProcessProbe, host: Host, hwnd: number): Promise<number> {
  const closeAt = Date.now();
  await probe.close(hwnd);
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
  return Date.now() - closeAt;
}

/** 每个场景的采样（08 §1）：静置后每 2 s 采一次，共 5 次，取中位数。 */
const SAMPLES = 5;
const SAMPLE_INTERVAL_MS = 2_000;
/** 深分页翻到第几页：100 条一页，第 40 页 ≈ 2.x 口径的 offset 4000。 */
const DEEP_PAGES = 40;

type ProgressStep = { atMs: number; phase: string; done: number; total: number };

/**
 * 首次转换（08 §3：样本库 ≤ 60 s，并且有进度）：L 是样本副本、N 空着，--background 拉起生产包，
 * 量 spawn → 服务健康；期间轮询 startup-progress.json，记下每一次推进。完成后宿主退出、存快照。
 */
async function firstConversion(executable: string, probe: ProcessProbe) {
  freshRunData();
  const progressPath = join(v3Dir, "runtime", "startup-progress.json");
  const host = startHost(executable, ["--background"]);
  const started = performance.now();
  const progress: ProgressStep[] = [];
  let last = "";
  try {
    await until(
      async () => {
        try {
          const current = JSON.parse(readFileSync(progressPath, "utf8")) as {
            phase: string;
            progress: { done: number; total: number };
          };
          const key = `${current.phase}:${current.progress.done}/${current.progress.total}`;
          if (key !== last) {
            last = key;
            progress.push({
              atMs: Math.round(performance.now() - started),
              phase: current.phase,
              done: current.progress.done,
              total: current.progress.total,
            });
          }
        } catch {
          // 还没写，或正在原子替换：下一轮再读。
        }
        return (await healthy()) ? true : null;
      },
      180_000,
      "首次转换完成并健康",
      50,
    );
    const healthMs = Math.round(performance.now() - started);
    await sleep(3_000);
    const quit = await quitHost(host, probe);
    const converted = existsSync(join(v3Dir, "conversion.json"));
    return {
      healthMs,
      converted,
      progress,
      phases: [...new Set(progress.map((step) => step.phase))],
      quit,
    };
  } finally {
    if (!childExited(host.child)) killProcessTree(host.pid);
  }
}

/**
 * Agent 负载（08 §1 场景 2，都走 Agent HTTP 的 3.x 路由）：项目列表、brief（3.x 里 overview 只给
 * 界面）、深分页（按 next_cursor 翻 DEEP_PAGES 页）、中文检索、events、system/status。
 * 任何一个不是 200 都算这一轮没测成：拿 404 的空回包量出来的内存不算数。
 */
async function agentLoad(runtime: { endpoint: string; token: string }) {
  const headers = { authorization: `Bearer ${runtime.token}` };
  const get = async (path: string) => {
    const response = await agentFetch(`${runtime.endpoint}${path}`, { headers });
    const text = Buffer.from(await response.arrayBuffer()).toString("utf8");
    if (response.status !== 200)
      throw new Error(`Agent 负载请求失败：${path} → ${response.status} ${text.slice(0, 300)}`);
    return text;
  };
  const fixed = [
    "/api/v1/projects",
    "/api/v1/projects/PFM/brief",
    `/api/v1/projects/PFM/search?query=${encodeURIComponent("项目验证关键词")}&limit=20`,
    "/api/v1/projects/PFM/events?since=0&limit=100",
    "/api/v1/system/status",
  ];
  let requests = 0;
  let deepestPage = 0;
  for (let round = 0; round < 10; round += 1) {
    for (const path of fixed) {
      await get(path);
      requests += 1;
    }
    let cursor: string | null = null;
    for (let page = 1; page <= DEEP_PAGES; page += 1) {
      const body = JSON.parse(
        await get(
          `/api/v1/projects/PFM/work-items?status=READY&limit=100${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
        ),
      ) as { items: unknown[]; has_more: boolean; next_cursor?: string | null };
      requests += 1;
      deepestPage = Math.max(deepestPage, page);
      if (!body.has_more || !body.next_cursor) break;
      cursor = body.next_cursor;
    }
  }
  return { requests, deepestPage, paths: [...fixed, "/api/v1/projects/PFM/work-items (cursor)"] };
}

async function measureMemory(executable: string, probe: ProcessProbe, windows: NativeWindowProbe) {
  convertedRunData();
  const host = startHost(executable, ["--background"]);
  try {
    const runtime = await until(healthy, 60_000, "服务健康", 100);
    // 起来之后先空着：首轮维护（2.5 s）、订阅、更新检查都跑过一遍。
    await sleep(30_000);
    const idle = await sampleSeries(probe, host.pid, SAMPLES, SAMPLE_INTERVAL_MS);

    const agent = await agentLoad(runtime);
    await sleep(15_000);
    const afterAgent = await sampleSeries(probe, host.pid, SAMPLES, SAMPLE_INTERVAL_MS);

    type Series = Awaited<ReturnType<typeof sampleSeries>>;
    const cyclesOut: Array<{
      cycle: number;
      visibleMs: number;
      webviewGoneMs: number;
      open: Series;
      closed: Series;
    }> = [];
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
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
      const open = await sampleSeries(probe, host.pid, SAMPLES, SAMPLE_INTERVAL_MS);
      const webviewGoneMs = await closeWindow(probe, host, visible.hwnd);
      await sleep(10_000);
      const closed = await sampleSeries(probe, host.pid, SAMPLES, SAMPLE_INTERVAL_MS);
      cyclesOut.push({ cycle, visibleMs, webviewGoneMs, open, closed });
    }
    // 宿主每分钟记一次 rss（lifecycle heartbeat），与开关窗事件放在一起看有没有缓慢上涨。
    const lifecycle = join(v3Dir, "logs", "lifecycle.ndjson");
    const heartbeats = existsSync(lifecycle)
      ? readFileSync(lifecycle, "utf8")
          .split(/\r?\n/u)
          .filter((line) =>
            /"event":"(?:heartbeat|window\.shown|window\.closed|window\.released)"/u.test(line),
          )
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    return {
      agent,
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
      () => (existsSync(runtimeFile(v3Dir)) ? performance.now() - started : null),
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
  rmSync(devToolsPortFile(v3Dir), { force: true });
  const host = startHost(executable, []);
  const startedWall = Date.now();
  const started = performance.now();
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    const daemonJson = await until(
      () => (existsSync(runtimeFile(v3Dir)) ? performance.now() - started : null),
      30_000,
      "daemon.json",
      10,
    );
    const port = await until(() => readDevToolsPort(v3Dir), 30_000, "DevTools 端口", 10);
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

/**
 * 08 §1 场景 6：导出一个大项目之后。导出只给用户（00 C-07），走界面的 bridge；生产包没有 CDP，
 * 只能用 smoke 构建从外面驱动（宿主代码与生产包相同，只多 CDP 与 SMOKE_QUIT）。同一个进程里：
 * 后台空闲先量一轮作对照 → 开窗、经 bridge 导出主项目 → 关窗、WebView2 退干净、静置后再量。
 */
async function measureExport(executable: string, probe: ProcessProbe, windows: NativeWindowProbe) {
  convertedRunData(true);
  rmSync(devToolsPortFile(v3Dir), { force: true });
  const host = startHost(executable, ["--background"]);
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    await until(healthy, 60_000, "服务健康", 100);
    await sleep(30_000);
    const idle = await sampleSeries(probe, host.pid, SAMPLES, SAMPLE_INTERVAL_MS);

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
    const port = await until(() => readDevToolsPort(v3Dir), 30_000, "DevTools 端口", 20);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
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
    const exportStarted = performance.now();
    const exported = await rendererRequest<Record<string, unknown>>(
      page,
      "POST",
      "/api/v1/exports/PFM",
    );
    const exportMs = Math.round(performance.now() - exportStarted);
    if (exported.status < 200 || exported.status >= 300)
      throw new Error(
        `导出失败：${exported.status} ${JSON.stringify(exported.body).slice(0, 300)}`,
      );
    await browser.close().catch(() => undefined);
    browser = null;
    const webviewGoneMs = await closeWindow(probe, host, visible.hwnd);
    await sleep(10_000);
    const afterExport = await sampleSeries(probe, host.pid, SAMPLES, SAMPLE_INTERVAL_MS);
    return {
      idle,
      exportStatus: exported.status,
      exportMs,
      webviewGoneMs,
      afterExport,
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

report.seed = await ensureSampleLibrary(seedDir, repoRoot);
const production = unpackPortable(packageDir, portableRoot);
const smoke = smokeExecutable();
report.executables = { production, smoke };
// 候选绑定（L6）：量的是哪份二进制。生产便携包对 release 那套，smoke 构建对 smoke 那套。
report.binaries = {
  production: binariesOf(dirname(production)),
  smoke: binariesOf(dirname(smoke)),
};
save();

const probe = new ProcessProbe();
let windows: NativeWindowProbe | null = null;
let conversion: Awaited<ReturnType<typeof firstConversion>> | undefined;
let memory: Awaited<ReturnType<typeof measureMemory>> | undefined;
const foreground: Array<Awaited<ReturnType<typeof coldStartProduction>>> = [];
const background: Array<Awaited<ReturnType<typeof coldStartProduction>>> = [];
const smokeRuns: Array<Awaited<ReturnType<typeof coldStartSmoke>>> = [];
try {
  await probe.ready;
  windows = NativeWindowProbe.start();
  const nativeWindows = windows;
  await nativeWindows.windows(process.pid);
  await withLoginItemsRestored(async () => {
    // 首次转换只量一次：之后每一轮都从它转出来的快照开始，冷启动不含首次转换。
    conversion = await firstConversion(production, probe);
    report.conversion = conversion;
    save();
    requireExitConfirmed("首次转换", conversion.quit);
    snapshotConverted();

    memory = await measureMemory(production, probe, nativeWindows);
    report.memory = memory;
    save();
    requireExitConfirmed("内存测量", memory.quit);
    if (memoryOnly) return;

    // 第一轮带着内存测量那次运行留下的 WebView2 用户数据目录，和用户日常登录一致。
    for (let run = 0; run < coldRuns; run += 1) {
      convertedRunData(true);
      const result = await coldStartProduction(production, probe, nativeWindows, false);
      foreground.push(result);
      report.coldStartProduction = { foreground };
      save();
      requireExitConfirmed(`前台冷启动第 ${run + 1} 轮`, result.quit);
    }
    for (let run = 0; run < coldRuns; run += 1) {
      convertedRunData(true);
      const result = await coldStartProduction(production, probe, nativeWindows, true);
      background.push(result);
      report.coldStartProduction = { foreground, background };
      save();
      requireExitConfirmed(`后台冷启动第 ${run + 1} 轮`, result.quit);
    }

    for (let run = 0; run < Math.min(coldRuns, 3); run += 1) {
      convertedRunData(true);
      const result = await coldStartSmoke(smoke, probe, nativeWindows);
      smokeRuns.push(result);
      report.coldStartSmoke = smokeRuns;
      save();
      requireExitConfirmed(`smoke 冷启动第 ${run + 1} 轮`, result.quit);
    }

    const exported = await measureExport(smoke, probe, nativeWindows);
    report.exportScenario = exported;
    save();
    requireExitConfirmed("导出场景", exported.quit);
  }, [production, smoke]);
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  probe.stop();
  windows?.close();
  const verdicts = budgetVerdicts({
    sizes: report.sizes as { payloadBytes: number; updateZipBytes: number },
    conversion,
    memory,
    foreground,
    background,
  });
  report.summary = {
    coldStart: {
      foreground: {
        daemonJsonMs: stats(foreground.map((run) => run.daemonJsonMs)),
        healthMs: stats(foreground.map((run) => run.healthMs)),
        windowVisibleMs: stats(foreground.map((run) => run.windowVisibleMs)),
      },
      background: { healthMs: stats(background.map((run) => run.healthMs)) },
      smoke: {
        rendererReadyMs: stats(smokeRuns.map((run) => run.rendererReadyMs)),
        interactiveMs: stats(smokeRuns.map((run) => run.interactiveMs)),
      },
    },
    verdicts,
    // 只量了内存（--memory-only）时冷启动那几条必然没有样本：不算全部达标。
    allPass: verdicts.every((verdict) => verdict.pass),
  };
  report.completedAt = new Date().toISOString();
  save();
}
process.stdout.write(`${jsonPath}\n`);
const failedVerdicts = (
  report.summary as { verdicts: Array<{ item: string; pass: boolean }> }
).verdicts.filter((verdict) => !verdict.pass);
if (report.error) {
  process.stderr.write(`${String(report.error)}\n`);
  process.exitCode = 1;
} else if (failedVerdicts.length > 0) {
  process.stderr.write(`预算未达标：${failedVerdicts.map((verdict) => verdict.item).join("、")}\n`);
  process.exitCode = 1;
}
