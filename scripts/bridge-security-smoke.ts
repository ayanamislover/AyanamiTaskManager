/**
 * 渲染器桥安全烟测（de-electron §5 / §9 负例）：在原生 smoke 宿主上实测单元测试够不着的几条。
 *
 *   - iframe / srcdoc / data / 外站 frame：一个都加载不起来（CSP frame-src 'none' + 宿主取消
 *     一切 frame 导航，两层各自独立）；
 *   - frame 里的脚本用 chrome.webview / window.ipc 发桥消息：宿主一条都不受理；
 *   - 顶层文档导航到入口以外（外站、data:、about:blank）被拦下，window.open 被拒；
 *   - 导航竞态：旧文档发出的请求在重载之后才回来，回包不得投递给新文档（generation+epoch）。
 *
 * 观测方法：宿主每次投递回包都是一次 `evaluate_script("window.__atmBridge&&…resolve({…})")`，
 * 在页面里就是一段新编译的脚本。CDP Debugger.scriptParsed 能看到每一段，所以「宿主有没有受理、
 * 有没有投递」不靠猜、不靠时间窗：每组负例之后，顶层文档再发一条哨兵，宿主按顺序处理消息，
 * 哨兵的回包出现时，排在它前面的消息若被受理，其回包必然已经出现。
 *
 * 导航竞态要让旧请求「必然」晚于重载：先把本次拉起的 core 进程挂起（NtSuspendProcess，只对
 * 自己沙箱里的 core，按 PID + 映像路径核对），旧文档发请求、重载、新文档加载完，再恢复 core。
 *
 * 只有 smoke 构建开 CDP。数据根在 output/bridge-security-smoke-data；报告写
 * output/bridge-security-smoke-report.json。被测宿主默认是 output/package-smoke 里那份，
 * 验红时用 ATM_PACKAGED_EXE 指向放了「重新打开漏洞」的宿主的副本。
 *
 *   pnpm exec tsx scripts/bridge-security-smoke.ts
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import {
  CheckLog,
  connectRenderer,
  delay,
  killProcessTree,
  outputRoot,
  prepareSandbox,
  requestShow,
  smokeExecutable,
  startSmokeHost,
  stopSmokeHost,
  waitForRuntime,
  snapshotLoginItems,
  type SmokeHost,
  type SmokeRenderer,
} from "./smoke-host.js";
import { withPowerShellScratch } from "./powershell-scratch.js";

const ENTRY = "https://atm.localhost/index.html";
const RESOLVE_PREFIX = "window.__atmBridge&&window.__atmBridge.resolve(";
/** 被拦下的导航不会产生任何事件；只给「万一放行了」留出提交的时间，不是轮询。 */
const NAVIGATION_GRACE_MS = 1_500;

const executable = smokeExecutable();
const reportPath = join(outputRoot, "bridge-security-smoke-report.json");
const log: CheckLog = new CheckLog();
// 每一条负例都要跑完并进报告：验红时要看到「哪几条」变红，而不是停在第一条。
log.soft = true;

/** 宿主投递给页面的每一段回包脚本，按到达顺序编号。 */
class DeliveryLog {
  readonly scripts: Array<{ seq: number; source: string }> = [];
  private seq = 0;
  private readonly waiters: Array<{ match: (source: string) => boolean; done: () => void }> = [];

  constructor(private readonly cdp: CDPSession) {
    cdp.on("Debugger.scriptParsed", (event: { scriptId: string; url: string; length?: number }) => {
      if (event.url !== "") return;
      void cdp
        .send("Debugger.getScriptSource", { scriptId: event.scriptId })
        .then(({ scriptSource }) => {
          if (!scriptSource.startsWith(RESOLVE_PREFIX)) return;
          this.scripts.push({ seq: ++this.seq, source: scriptSource });
          for (const waiter of [...this.waiters])
            if (waiter.match(scriptSource)) {
              this.waiters.splice(this.waiters.indexOf(waiter), 1);
              waiter.done();
            }
        })
        .catch(() => undefined);
    });
  }

  mark(): number {
    return this.seq;
  }

  since(mark: number): string[] {
    return this.scripts.filter((entry) => entry.seq > mark).map((entry) => entry.source);
  }

  /** 等到一段满足条件的回包出现（已经出现过也算）。 */
  async waitFor(match: (source: string) => boolean, timeoutMs = 10_000): Promise<boolean> {
    if (this.scripts.some((entry) => match(entry.source))) return true;
    return Promise.race([
      new Promise<boolean>((done) => this.waiters.push({ match, done: () => done(true) })),
      delay(timeoutMs).then(() => false),
    ]);
  }
}

const hasId = (id: number) => (source: string) => source.includes(`"id":${id},`);

/** 从顶层文档发一条哨兵，等它的回包：此前发出的、若被受理的消息，回包都已投递。 */
async function sentinel(page: Page, deliveries: DeliveryLog, id: number): Promise<boolean> {
  await page.evaluate(
    (messageId) =>
      (window as any).chrome.webview.postMessage(
        JSON.stringify({ id: messageId, method: "getAutoLaunch", args: [] }),
      ),
    id,
  );
  return deliveries.waitFor(hasId(id));
}

/** 只挂起/恢复本次拉起的 core：PID 来自沙箱的 daemon.json，映像必须是被测版本目录里的 atm-core.exe。 */
function setCoreSuspended(pid: number, appDir: string, suspended: boolean): void {
  const expected = join(appDir, "runtime", "atm-core.exe").replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace AtmSmoke -Name Nt -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);'
$process = [System.Diagnostics.Process]::GetProcessById(${pid})
if ($process.Path -ne '${expected}') { throw "not our core: $($process.Path)" }
$status = [AtmSmoke.Nt]::${suspended ? "NtSuspendProcess" : "NtResumeProcess"}($process.Handle)
if ($status -ne 0) { throw "NTSTATUS $status" }
`;
  const result = withPowerShellScratch((env) =>
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env,
    }),
  );
  if (result.status !== 0)
    throw new Error(`${suspended ? "挂起" : "恢复"} core 失败：${result.stderr || result.stdout}`);
}

type TreeEntry = { pid: number; ppid: number; exe: string };

/** Toolhelp32 快照里的全部进程（只读 PID / 父 PID / 映像名，不走 WMI/CIM）。 */
function processSnapshot(): TreeEntry[] {
  const script = `
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class AtmSmokeTree {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Entry { public uint Size; public uint Usage; public uint Pid; public IntPtr Heap; public uint Module; public uint Threads; public uint Parent; public int Priority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe; }
  [DllImport("kernel32.dll")] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  public static string List() {
    var rows = new List<string>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    var entry = new Entry { Size = (uint)Marshal.SizeOf(typeof(Entry)) };
    for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry))
      rows.Add("{\\"pid\\":" + entry.Pid + ",\\"ppid\\":" + entry.Parent + ",\\"exe\\":\\"" + entry.Exe.Replace("\\\\", "\\\\\\\\").Replace("\\"", "") + "\\"}");
    CloseHandle(snapshot);
    return "[" + string.Join(",", rows.ToArray()) + "]";
  }
}
"@
[AtmSmokeTree]::List()
`;
  const result = withPowerShellScratch((env) =>
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env,
    }),
  );
  if (result.status !== 0) throw new Error(`进程快照失败：${result.stderr}`);
  return JSON.parse(result.stdout.trim()) as TreeEntry[];
}

/** rootPid 的全部子孙（WebView2 浏览器进程挂在宿主下面，渲染/GPU 进程挂在浏览器进程下面）。 */
function descendants(rootPid: number, snapshot = processSnapshot()): TreeEntry[] {
  const found: TreeEntry[] = [];
  const parents = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of snapshot)
      if (parents.has(entry.ppid) && !parents.has(entry.pid) && entry.pid !== entry.ppid) {
        parents.add(entry.pid);
        found.push(entry);
        grew = true;
      }
  }
  return found;
}

/**
 * 宿主退出后还活着的、本次拉起的 WebView2 进程（验红时放开 window.open 会留下弹窗的浏览器进程）。
 * 只按运行中记下的 PID 收尾，并核对映像名与「父进程是记下的进程或已退出的宿主」，从不按镜像名。
 */
function reapOrphans(hostPid: number, seen: TreeEntry[]): number[] {
  if (seen.length === 0) return [];
  const known = new Set([hostPid, ...seen.map((entry) => entry.pid)]);
  const reaped: number[] = [];
  for (const entry of processSnapshot())
    if (
      known.has(entry.pid) &&
      entry.pid !== hostPid &&
      entry.exe.toLowerCase() === "msedgewebview2.exe" &&
      known.has(entry.ppid)
    ) {
      killProcessTree(entry.pid);
      reaped.push(entry.pid);
    }
  return reaped;
}

type FrameProbe = {
  kind: string;
  outcome: string;
  /** 同源可读时 frame 文档里的文本；跨源或被替换成错误页时为 null。 */
  text: string | null;
};

async function frameCases(page: Page, cdp: CDPSession, deliveries: DeliveryLog): Promise<void> {
  const marker = `frame-loaded-${randomUUID()}`;
  const committed: Array<{ url: string; parentId?: string }> = [];
  const onNavigated = (event: { frame: { url: string; parentId?: string } }) => {
    if (event.frame.parentId)
      committed.push({ url: event.frame.url, parentId: event.frame.parentId });
  };
  cdp.on("Page.frameNavigated", onNavigated);
  // 页内脚本用字符串传：tsx 会给具名函数包 __name()，页面里没有这个辅助函数。
  const probes = (await page.evaluate(`(async () => {
    const marker = ${JSON.stringify(marker)};
    const cases = [
      ["same-origin entry", { src: ${JSON.stringify(ENTRY)} }],
      ["same-origin relative", { src: "/index.html" }],
      ["external site", { src: "https://example.com/" }],
      ["srcdoc", { srcdoc: "<p>" + marker + "</p>" }],
      ["data url", { src: "data:text/html,<p>" + marker + "</p>" }],
      ["about:blank", { src: "about:blank" }],
    ];
    return Promise.all(cases.map(([kind, attributes]) => new Promise((done) => {
      const frame = document.createElement("iframe");
      frame.dataset.securityProbe = kind;
      for (const [name, value] of Object.entries(attributes)) frame.setAttribute(name, value);
      let settled = false;
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        let text = null;
        try { text = frame.contentDocument?.documentElement?.textContent ?? null; } catch { text = null; }
        done({ kind, outcome, text });
      };
      frame.addEventListener("load", () => settle("load"), { once: true });
      setTimeout(() => settle("no-load"), 3000);
      document.body.appendChild(frame);
    })));
  })()`)) as FrameProbe[];
  cdp.off("Page.frameNavigated", onNavigated);

  for (const probe of probes)
    log.check(
      `frame「${probe.kind}」不能加载出内容`,
      !(probe.text ?? "").includes(marker) && !(probe.text ?? "").includes("AyanamiTaskManager"),
      JSON.stringify(probe),
    );
  const loaded = committed.filter(
    (entry) =>
      entry.url.startsWith("https://atm.localhost") ||
      entry.url.startsWith("https://example.com") ||
      entry.url.startsWith("data:") ||
      entry.url === "about:srcdoc",
  );
  log.check(
    "没有任何子 frame 提交到入口、外站、data: 或 srcdoc",
    loaded.length === 0,
    JSON.stringify(committed),
  );

  // frame 里的脚本：每个还能进得去的 frame（同源的 about:blank 初始文档等）都从内部发桥消息。
  const frameIds: number[] = [];
  let nextId = 910_000;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const ids = { webview: nextId++, ipc: nextId++ };
    const sent = (await frame
      .evaluate(
        `(() => {
        const ids = ${JSON.stringify(ids)};
        const post = (target, id) => {
          if (typeof target?.postMessage !== "function") return false;
          target.postMessage(JSON.stringify({ id, method: "getAutoLaunch", args: [] }));
          return true;
        };
        return {
          url: location.href,
          webview: post(window.chrome?.webview, ids.webview),
          ipc: post(window.ipc, ids.ipc),
          // 子 frame 自己的 ayanamiDesktop 不该存在（初始化脚本只装顶层）。
          bridgeInFrame: typeof window.ayanamiDesktop !== "undefined",
        };
      })()`,
      )
      .catch((error: unknown) => ({ url: frame.url(), error: String(error) }))) as
      | { url: string; webview: boolean; ipc: boolean; bridgeInFrame: boolean }
      | { url: string; error: string };
    if ("webview" in sent && sent.webview) frameIds.push(ids.webview);
    if ("ipc" in sent && sent.ipc) frameIds.push(ids.ipc);
    log.check(
      `frame ${frame.url() || "(空)"} 里没有 window.ayanamiDesktop`,
      !("bridgeInFrame" in sent) || sent.bridgeInFrame === false,
      JSON.stringify(sent),
    );
  }
  log.record(
    "至少有一个 frame 发出了桥消息（负例不空转）",
    frameIds.length > 0,
    JSON.stringify(frameIds),
  );
  const sentinelSeen = await sentinel(page, deliveries, 919_999);
  log.check("frame 负例之后的哨兵照常回包", sentinelSeen);
  const accepted = frameIds.filter((id) =>
    deliveries.scripts.some((entry) => hasId(id)(entry.source)),
  );
  log.check("frame 里发出的桥消息一条都没被受理", accepted.length === 0, JSON.stringify(accepted));
  await page.evaluate(() =>
    document.querySelectorAll("iframe[data-security-probe]").forEach((frame) => frame.remove()),
  );
}

async function navigationRace(
  page: Page,
  deliveries: DeliveryLog,
  corePid: number,
  appDir: string,
): Promise<void> {
  const stale = `race-stale-${randomUUID()}`;
  const fresh = `race-fresh-${randomUUID()}`;
  const before = await page.evaluate(() => performance.timeOrigin);
  setCoreSuspended(corePid, appDir, true);
  let resumed = false;
  try {
    await page.evaluate((path) => {
      (window as any).__raceProbe = (window as any).ayanamiDesktop.runtimeRequest({ path });
    }, `/api/v1/${stale}`);
    // 本地方法由宿主直接回答。宿主按顺序处理消息：它的回包回来时，上面那条已转给 core。
    await page.evaluate(() => (window as any).ayanamiDesktop.isWindowMaximized());
    const mark = deliveries.mark();
    await Promise.all([
      page.waitForEvent("load", { timeout: 30_000 }),
      page.evaluate((entry) => {
        location.href = entry;
      }, ENTRY),
    ]);
    const after = await page.evaluate(() => performance.timeOrigin);
    log.check("重载换了一个新文档", after !== before, `${before} → ${after}`);
    setCoreSuspended(corePid, appDir, false);
    resumed = true;
    // 旧请求排在 core 的 stdin 最前面；新文档这一条回来时，旧的那条早已回给宿主。
    const answer = (await page.evaluate(
      (path) => (window as any).ayanamiDesktop.runtimeRequest({ path }),
      `/api/v1/${fresh}`,
    )) as { status: number; body: string };
    log.check(
      "新文档自己的请求拿到的是自己的回包",
      answer.body.includes(fresh) && !answer.body.includes(stale),
      JSON.stringify(answer).slice(0, 300),
    );
    // 新文档的回包能被看到（观测有效），旧文档那条一次都没投递进来。
    log.check(
      "观测有效：新文档的回包经 resolve 投递可见",
      await deliveries.waitFor((source) => source.includes(fresh)),
    );
    const leaked = deliveries.since(mark).filter((source) => source.includes(stale));
    log.check("旧文档的回包没有投递给新文档", leaked.length === 0, leaked.join("\n").slice(0, 500));
  } finally {
    if (!resumed) setCoreSuspended(corePid, appDir, false);
  }
}

async function topLevelNavigation(
  page: Page,
  renderer: SmokeRenderer,
  cdp: CDPSession,
): Promise<void> {
  const pagesBefore = renderer.browser.contexts().flatMap((context) => context.pages()).length;
  const opened = await page.evaluate(() => window.open("https://example.com/", "_blank") === null);
  log.check("window.open 被拒（返回 null）", opened);
  for (const target of [
    "https://example.com/",
    "data:text/html,<p>navigated</p>",
    "about:blank",
    "https://atm.localhost/other.html",
  ]) {
    const origin = await page.evaluate(() => performance.timeOrigin).catch(() => null);
    const committed: string[] = [];
    const onNavigated = (event: { frame: { url: string; parentId?: string } }) => {
      if (!event.frame.parentId) committed.push(event.frame.url);
    };
    cdp.on("Page.frameNavigated", onNavigated);
    await page
      .evaluate((url) => {
        location.href = url;
      }, target)
      .catch(() => undefined);
    await delay(NAVIGATION_GRACE_MS);
    cdp.off("Page.frameNavigated", onNavigated);
    const state = await page
      .evaluate(() => ({
        href: location.href,
        origin: performance.timeOrigin,
        bridge: typeof (window as any).ayanamiDesktop?.runtimeRequest === "function",
      }))
      .catch((error: unknown) => ({ href: String(error), origin: null, bridge: false }));
    log.check(
      `顶层导航到 ${target} 被拦下`,
      committed.length === 0 &&
        state.origin === origin &&
        state.href.startsWith(ENTRY) &&
        state.bridge,
      JSON.stringify({ committed, state }),
    );
  }
  const pagesAfter = renderer.browser.contexts().flatMap((context) => context.pages()).length;
  log.check("没有冒出新窗口", pagesAfter === pagesBefore, `${pagesBefore} → ${pagesAfter}`);
}

/** 运行中见过的宿主子孙进程，收尾时用来清理孤儿。 */
const seenTree: TreeEntry[] = [];

async function run(host: SmokeHost): Promise<void> {
  const runtime = await waitForRuntime(host);
  await requestShow(host);
  const renderer = await connectRenderer(host);
  seenTree.push(...descendants(host.pid));
  try {
    const { page } = renderer;
    await page.waitForSelector(".atm-shell", { timeout: 30_000 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.enable");
    await cdp.send("Debugger.enable");
    const deliveries = new DeliveryLog(cdp);

    // 阳性对照：顶层文档自己发的消息，回包能被观测到。
    log.check("观测有效：顶层文档的桥消息有回包", await sentinel(page, deliveries, 900_001));

    await frameCases(page, cdp, deliveries);
    await navigationRace(page, deliveries, runtime.pid, dirname(host.executable));
    await page.waitForSelector(".atm-shell", { timeout: 30_000 });
    await topLevelNavigation(page, renderer, cdp);
    seenTree.push(...descendants(host.pid));
    await cdp.detach().catch(() => undefined);
  } finally {
    await renderer.browser.close().catch(() => undefined);
  }
}

const sandbox = await prepareSandbox("bridge-security-smoke");
// 先拍 Run 快照再启动宿主：读不到就什么都不启动。
const loginItems = snapshotLoginItems();
const host = startSmokeHost({ executable, dataDir: sandbox.dataDir, env: sandbox.env });
let error: unknown;
try {
  await loginItems.restoreAfter(async () => {
    try {
      await run(host);
    } finally {
      log.record("--smoke-quit 干净退出", await stopSmokeHost(host), host.stderr.join(""));
      const orphans = reapOrphans(host.pid, seenTree);
      log.record(
        "宿主退出后没有遗留的 WebView2 进程",
        orphans.length === 0,
        JSON.stringify(orphans),
      );
    }
  });
} catch (caught) {
  error = caught;
}
const hostLog = join(sandbox.dataDir, "logs", "host.log");
const rejectedLines = existsSync(hostLog)
  ? readFileSync(hostLog, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.includes("renderer message rejected"))
  : [];
const passed = error === undefined && log.failed.length === 0;
const report = {
  passed,
  executable: resolve(executable),
  dataDir: sandbox.dataDir,
  completedAt: new Date().toISOString(),
  checks: log.checks,
  hostRejectedMessages: rejectedLines.length,
  ...(error === undefined
    ? {}
    : { error: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!passed) process.exitCode = 1;
