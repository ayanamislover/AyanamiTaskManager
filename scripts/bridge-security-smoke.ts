/**
 * 渲染器桥安全烟测（de-electron §5 / §9 负例；ATM 3 W5e）：在 smoke 构建的开发版宿主上实测单元测试够不着的几条。
 *
 *   - 界面请求经真实的 WebView 进 ui-bridge（03 §2.1、10 R8）：
 *     - 正常读写成功，Agent 经 daemon.json 能看到界面建的项目；
 *     - 绝对 URL、编码的 `..`、Agent 专用路由、不支持的方法、超过 2 MiB 的 body 都在进服务之前被拒；
 *     - 在途请求超过 64 条回 SERVICE_BUSY；
 *     - `showItemInFolder` 已删除（06、00 C-14）；
 *     - 还没接上的宿主方法回明确的错误码，不悬着。
 *   - iframe / srcdoc / data / 外站 frame：一个都加载不起来（CSP frame-src 'none' + 宿主取消
 *     一切 frame 导航，两层各自独立）。
 *   - frame 里的脚本用 chrome.webview / window.ipc 发桥消息：宿主一条都不受理。
 *   - 顶层文档导航到入口以外（外站、data:、about:blank）被拦下，window.open 被拒。
 *   - 导航竞态：旧文档发出的请求在重载之后才回来，回包不得投递给新文档（generation + epoch，03 U4）。
 *   - 关窗之后通知照常（W5f）：窗口与 WebView 销毁后，Agent 经 HTTP 让任务受阻，宿主照样收到通知
 *     （host.log 出现 toast 的结果）；宿主不随窗口退出。
 *
 * 观测方法：宿主每次投递回包都是一次 `evaluate_script("window.__atmBridge&&…resolve({…})")`，
 * 在页面里就是一段新编译的脚本。CDP Debugger.scriptParsed 能看到每一段，所以「宿主有没有受理、
 * 有没有投递」不靠猜、不靠时间窗：每组负例之后，顶层文档再发一条哨兵，宿主按顺序处理消息，
 * 哨兵的回包出现时，排在它前面的消息若被受理，其回包必然已经出现。
 *
 * 3.0 没有可以挂起的 core 进程：导航竞态与在途上限用 smoke 构建才有的 `/__smoke/hold`
 * （宿主在工作线程上停一会儿再回，回包带标记；`host/src/ui_api.rs`）。
 *
 * 宿主是脚本自己构建的开发版（`cargo build -p atm-host --features smoke`，界面是 `vite build` 的
 * dist/renderer）。环境只用合成的 LOCALAPPDATA：L、N 都落在 output/bridge-security-smoke-home 里，
 * ATM_DATA_DIR、AYANAMI_TASK_DATA_DIR、ATM3_DATA_DIR 一律不传。报告写 output/bridge-security-smoke-report.json。
 * 验红时用 ATM_SMOKE_HOST_EXE 指向放了「重新打开漏洞」的宿主（跳过构建）。
 *
 *   pnpm exec tsx scripts/bridge-security-smoke.ts
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { get as httpGet, request as httpRequest } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import { assertSmokeHost } from "./package-native.js";
import {
  assertSandboxDataDir,
  CheckLog,
  connectRenderer,
  delay,
  killProcessTree,
  outputRoot,
  repoRoot,
  requestShow,
  snapshotLoginItems,
  startSmokeHost,
  stopSmokeHost,
  waitUntil,
  type SmokeHost,
  type SmokeRenderer,
} from "./smoke-host.js";
import { withPowerShellScratch } from "./powershell-scratch.js";

const ENTRY = "https://atm.localhost/index.html";
const RESOLVE_PREFIX = "window.__atmBridge&&window.__atmBridge.resolve(";
/** 被拦下的导航不会产生任何事件；只给「万一放行了」留出提交的时间，不是轮询。 */
const NAVIGATION_GRACE_MS = 1_500;
/** 宿主同时在途的界面请求上限（host/src/app.rs MAX_UI_IN_FLIGHT）。 */
const UI_IN_FLIGHT = 64;

const native = join(repoRoot, "apps", "desktop", "native");
const reportPath = join(outputRoot, "bridge-security-smoke-report.json");
const log: CheckLog = new CheckLog();
// 每一条负例都要跑完并进报告：验红时要看到「哪几条」变红，而不是停在第一条。
log.soft = true;

/** 构建 smoke 宿主与界面；给了 ATM_SMOKE_HOST_EXE（验红用的副本）就直接用它。 */
function smokeHost(): string {
  const given = process.env.ATM_SMOKE_HOST_EXE;
  if (given === undefined) {
    const build = (command: string, args: string[], cwd: string, env = process.env) => {
      const result = spawnSync(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
      if (result.status !== 0)
        throw new Error(`${command} ${args.join(" ")} 失败：${result.status}`);
    };
    build(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "build", "--config", "apps/desktop/vite.config.ts"],
      repoRoot,
    );
    build("cargo", ["build", "--locked", "-p", "atm-host", "--features", "smoke"], native, {
      ...process.env,
      CARGO_TARGET_DIR: join(native, "target"),
    });
  }
  const executable = resolve(given ?? join(native, "target", "debug", "AyanamiTaskManager.exe"));
  if (!existsSync(executable)) throw new Error(`找不到烟测宿主：${executable}`);
  assertSmokeHost(readFileSync(executable));
  return executable;
}

/** 沙箱：只有合成的 home（LOCALAPPDATA 在它下面），三个数据根变量都不传。 */
function sandbox(): { home: string; n: string; env: NodeJS.ProcessEnv } {
  const home = assertSandboxDataDir(join(outputRoot, "bridge-security-smoke-home"));
  rmSync(home, { recursive: true, force: true, maxRetries: 2 });
  mkdirSync(join(home, "Local"), { recursive: true });
  mkdirSync(join(home, "Roaming"), { recursive: true });
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM3_DATA_DIR"].includes(entry[0]),
    ),
  );
  return {
    home,
    n: join(home, "Local", "AyanamiTaskManager3"),
    env: {
      ...inherited,
      LOCALAPPDATA: join(home, "Local"),
      APPDATA: join(home, "Roaming"),
      ATM_SMOKE_CORE_USERPROFILE: home,
      ATM_DEV_REPOSITORY_ROOT: repoRoot,
    },
  };
}

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

type Answer = { status: number; body: string };

/** 经真实的桥发一条界面请求。失败（桥拒绝）时回 `{error: code}`。 */
async function ui(
  page: Page,
  input: { path: string; method?: string; body?: string },
): Promise<Answer | { error: string }> {
  return page.evaluate(
    (request) =>
      (window as any).ayanamiDesktop.runtimeRequest(request).then(
        (answer: Answer) => answer,
        (failure: { code?: string; message?: string }) => ({
          error: failure.code ?? failure.message ?? "unknown",
        }),
      ),
    input,
  );
}

const status = (answer: Answer | { error: string }) => ("status" in answer ? answer.status : null);
const errorCode = (answer: Answer | { error: string }) =>
  "error" in answer
    ? answer.error
    : (JSON.parse(answer.body) as { error?: { code?: string } }).error?.code;

/** 像 Agent 一样发一条 GET（只带 Authorization），回状态码。 */
function agentGet(url: string, token: string): Promise<number> {
  return new Promise((done, fail) => {
    const request = httpGet(url, { headers: { authorization: `Bearer ${token}` } }, (response) => {
      response.resume();
      done(response.statusCode ?? 0);
    });
    request.on("error", fail);
  });
}

/** 像 Agent 一样发一条 JSON POST（只带 Authorization 与 Content-Type），回状态码与 JSON。 */
function agentPost(
  url: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((done, fail) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = { raw: text.slice(0, 300) };
          }
          done({ status: response.statusCode ?? 0, json });
        });
      },
    );
    request.on("error", fail);
    request.end(payload);
  });
}

/** Agent 经 daemon.json 找服务（与 atm-mcp 桥同一份描述）。 */
function agentDescriptor(n: string): { endpoint: string; token: string } {
  return JSON.parse(readFileSync(join(n, "runtime", "daemon.json"), "utf8")) as {
    endpoint: string;
    token: string;
  };
}

/** 返回界面建的项目代码（关窗之后的通知检查还要用它）。 */
async function uiBridgeCases(page: Page, deliveries: DeliveryLog, n: string): Promise<string> {
  const statusAnswer = await ui(page, { path: "/api/v1/system/status" });
  log.check(
    "界面读 /system/status 经 ui-bridge 成功",
    status(statusAnswer) === 200 &&
      (JSON.parse((statusAnswer as Answer).body) as { ok?: boolean }).ok === true,
    JSON.stringify(statusAnswer).slice(0, 300),
  );
  const code = `BS${randomUUID()
    .slice(0, 4)
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/gu, "X")}`;
  const created = await ui(page, {
    path: "/api/v1/projects",
    method: "POST",
    body: JSON.stringify({ name: `桥烟测 ${code}`, code, sourcePath: null }),
  });
  log.check(
    "界面经 ui-bridge 建项目（201）",
    status(created) === 201,
    JSON.stringify(created).slice(0, 300),
  );
  const agent = agentDescriptor(n);
  // 用 node:http，不用 fetch：fetch 自带 sec-fetch-* 头，Agent HTTP 一律拒绝带浏览器特征的请求
  // （真实的 Agent 与 atm-mcp 桥都不带）。
  const seen = await agentGet(`${agent.endpoint}/api/v1/projects/${code}`, agent.token);
  log.check("Agent 经 daemon.json 看得到界面建的项目", seen === 200, String(seen));

  // R8：都在进服务之前被拒。
  for (const [name, input, expected] of [
    ["绝对 URL", { path: "http://evil.example/api/v1/projects" }, 400],
    ["编码的 ..", { path: "/api/v1/projects/%2e%2e/settings" }, 400],
    ["Agent 专用的 begin", { path: "/api/v1/sessions", method: "POST", body: "{}" }, 404],
    ["不支持的方法", { path: "/api/v1/projects", method: "TRACE" }, 405],
    ["非对象的 JSON", { path: "/api/v1/projects", method: "POST", body: "[1]" }, 400],
  ] as const) {
    const answer = await ui(page, input);
    log.check(
      `R8：${name} 回 ${expected}`,
      status(answer) === expected,
      JSON.stringify(answer).slice(0, 300),
    );
  }
  const huge = await ui(page, {
    path: "/api/v1/projects",
    method: "POST",
    body: JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) }),
  });
  log.check(
    "R8：超过 2 MiB 的 body 被拒",
    errorCode(huge) === "ATM_RENDERER_BODY_TOO_LARGE" || status(huge) === 413,
    JSON.stringify(huge).slice(0, 300),
  );

  // showItemInFolder 已删除：桥上没有这个方法，硬发消息也没有回包。
  const reveal = await page.evaluate(() => typeof (window as any).ayanamiDesktop.showItemInFolder);
  log.check("桥上没有 showItemInFolder", reveal === "undefined", reveal);
  await page.evaluate(() =>
    (window as any).chrome.webview.postMessage(
      JSON.stringify({ id: 930_001, method: "showItemInFolder", args: ["C:\\Windows"] }),
    ),
  );
  log.check("showItemInFolder 之后的哨兵照常回包", await sentinel(page, deliveries, 930_002));
  log.check(
    "硬发的 showItemInFolder 没有被受理",
    !deliveries.scripts.some((entry) => hasId(930_001)(entry.source)),
  );

  // 更新（W5g）：源码运行没有安装根，不参与自动更新——状态与检查都是 UPDATE_UNSUPPORTED，「立即更新」
  // 不拉起安装。还没接上的宿主方法（W6 Agent 接入）回明确的错误码，不悬着。
  // 页内脚本用字符串传：tsx 会给具名函数包 __name()，页面里没有这个辅助函数。
  const pendingMethods = await page.evaluate(`(async () => {
    const desktop = window.ayanamiDesktop;
    const settle = (promise) =>
      Promise.race([
        promise.then(
          (value) => ({ value: value ?? null }),
          (failure) => ({ error: failure.code ?? "unknown" }),
        ),
        new Promise((done) => setTimeout(() => done({ error: "TIMEOUT" }), 5000)),
      ]);
    const code = (answer) => ("value" in answer ? (answer.value?.code ?? null) : answer);
    return {
      check: code(await settle(desktop.checkForUpdates())),
      status: code(await settle(desktop.getUpdateStatus())),
      apply: code(await settle(desktop.applyUpdate())),
      configs: await settle(desktop.getMcpConfigs()),
    };
  })()`);
  log.check(
    "更新：源码运行不参与（UPDATE_UNSUPPORTED），还没接上的宿主方法回明确的错误码",
    JSON.stringify(pendingMethods) ===
      JSON.stringify({
        check: "UPDATE_UNSUPPORTED",
        status: "UPDATE_UNSUPPORTED",
        apply: "UPDATE_UNSUPPORTED",
        configs: { error: "AGENTS_UNAVAILABLE" },
      }),
    JSON.stringify(pendingMethods),
  );

  // 在途上限：同时发 64 + 16 条要停 1.5 s 的请求，正好 16 条回 SERVICE_BUSY。
  const flood = (await page.evaluate(`(async () => {
    const desktop = window.ayanamiDesktop;
    const answers = await Promise.all(
      Array.from({ length: ${UI_IN_FLIGHT + 16} }, (_, index) =>
        desktop.runtimeRequest({ path: "/__smoke/hold?ms=1500&marker=flood-" + index }).then(
          () => "held",
          (failure) => failure.code ?? "unknown",
        ),
      ),
    );
    const counts = {};
    for (const answer of answers) counts[answer] = (counts[answer] ?? 0) + 1;
    return counts;
  })()`)) as Record<string, number>;
  log.check(
    `在途超过 ${UI_IN_FLIGHT} 条回 SERVICE_BUSY`,
    flood.held === UI_IN_FLIGHT && flood.SERVICE_BUSY === 16,
    JSON.stringify(flood),
  );
  return code;
}

/** 旧文档发一条要停 3 s 的请求，随即重载；新文档的请求先回来，旧的那条回来时不得投递给新文档。 */
async function navigationRace(page: Page, deliveries: DeliveryLog): Promise<void> {
  const stale = `race-stale-${randomUUID()}`;
  const fresh = `race-fresh-${randomUUID()}`;
  const before = await page.evaluate(() => performance.timeOrigin);
  await page.evaluate((path) => {
    (window as any).__raceProbe = (window as any).ayanamiDesktop.runtimeRequest({ path });
  }, `/__smoke/hold?ms=3000&marker=${stale}`);
  // 本地方法由宿主直接回答。宿主按顺序处理消息：它的回包回来时，上面那条已经交给工作线程。
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
  const answer = (await page.evaluate(
    (path) => (window as any).ayanamiDesktop.runtimeRequest({ path }),
    `/__smoke/hold?ms=0&marker=${fresh}`,
  )) as Answer;
  log.check(
    "新文档自己的请求拿到的是自己的回包",
    answer.body.includes(fresh) && !answer.body.includes(stale),
    JSON.stringify(answer).slice(0, 300),
  );
  log.check(
    "观测有效：新文档的回包经 resolve 投递可见",
    await deliveries.waitFor((source) => source.includes(fresh)),
  );
  // 旧请求停 3 s：等它在宿主里确实回来过（再多等 1 s）之后再看有没有漏进新文档。
  await delay(4_000);
  log.check("新文档之后的哨兵照常回包", await sentinel(page, deliveries, 940_001));
  const leaked = deliveries.since(mark).filter((source) => source.includes(stale));
  log.check("旧文档的回包没有投递给新文档", leaked.length === 0, leaked.join("\n").slice(0, 500));
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

/** host.log 里 toast 的结果行（只有「shown / failed」，不含任务内容）。 */
function toastLines(n: string): string[] {
  const path = join(n, "logs", "host.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.includes("toast shown") || line.includes("toast failed"));
}

/**
 * 关窗之后通知照常（W5f；06 §2「订阅由常驻 service 持有，关窗后照常工作」）：界面让宿主关窗（WebView 整个销毁），
 * 之后 Agent 经 HTTP 让一条任务受阻，宿主的观察器照样决定发通知、交给 toast。沙箱里没有开始菜单快捷方式，
 * toast 可能报 failed——那也说明通知已经到了宿主；要验的是「到没到」，不是 Windows 的通知设置。
 */
async function notifyAfterClose(renderer: SmokeRenderer, n: string, code: string): Promise<void> {
  const before = toastLines(n).length;
  const disconnected = new Promise<boolean>((done) => {
    renderer.browser.on("disconnected", () => done(true));
    setTimeout(() => done(false), 20_000);
  });
  await renderer.page.evaluate("window.ayanamiDesktop.closeWindow()").catch(() => undefined);
  log.check("关窗：WebView 已销毁（CDP 断开）", await disconnected);

  const agent = agentDescriptor(n);
  const api = `${agent.endpoint}/api/v1`;
  const begun = await agentPost(`${api}/sessions`, agent.token, {
    cwd: repoRoot,
    projectCode: code,
    mode: "project",
    agentId: "bridge-smoke-notify",
    displayName: "Bridge Smoke Notify",
    clientKind: "smoke",
    role: "PRIMARY",
    resume: false,
    allowProjectCreate: false,
  });
  const session = String(begun.json.session ?? "");
  log.check(
    "关窗后 Agent 照常 begin",
    begun.status === 201 && session !== "",
    JSON.stringify(begun).slice(0, 300),
  );
  const created = await agentPost(`${api}/projects/${code}/work-items`, agent.token, {
    session,
    opId: "bridge-smoke-notify-create",
    items: [
      {
        title: "关窗之后受阻",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
        acceptance: ["关窗之后照样通知"],
        checklist: [],
        verificationRequired: false,
      },
    ],
  });
  const entity = ((created.json.entities as Array<Record<string, unknown>> | undefined) ?? [])[0];
  let taskKey = String(entity?.key ?? "");
  let version = Number(entity?.version ?? 0);
  log.check(
    "关窗后 Agent 建任务",
    created.status === 201 && taskKey !== "",
    JSON.stringify(created).slice(0, 300),
  );
  for (const [operation, extra] of [
    ["claim", {}],
    ["start", {}],
    ["block", { blockedReason: "关窗之后卡住" }],
  ] as const) {
    const patched = await agentPost(`${api}/projects/${code}/work-items/patch`, agent.token, {
      session,
      opId: `bridge-smoke-notify-${operation}`,
      items: [{ taskKey, expectedVersion: version, operation, ...extra }],
    });
    const next = ((patched.json.entities as Array<Record<string, unknown>> | undefined) ?? [])[0];
    taskKey = String(next?.key ?? taskKey);
    version = Number(next?.version ?? version);
    log.check(
      `关窗后 Agent ${operation}`,
      patched.status === 200,
      JSON.stringify(patched).slice(0, 300),
    );
  }
  const after = await waitUntil(
    async () => {
      const lines = toastLines(n);
      return lines.length > before ? lines : null;
    },
    20_000,
    "关窗后的 toast",
  ).catch(() => toastLines(n));
  log.check(
    "关窗之后任务受阻，宿主照样收到通知（host.log 有新的 toast 结果）",
    after.length > before,
    after.slice(before).join("\n"),
  );
}

async function run(host: SmokeHost, n: string): Promise<void> {
  await waitUntil(
    async () => (existsSync(join(n, "runtime", "daemon.json")) ? true : null),
    120_000,
    "服务的 daemon.json",
  );
  await requestShow(host);
  const renderer = await connectRenderer(host, 60_000);
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

    const code = await uiBridgeCases(page, deliveries, n);
    await frameCases(page, cdp, deliveries);
    await navigationRace(page, deliveries);
    await page.waitForSelector(".atm-shell", { timeout: 30_000 });
    await topLevelNavigation(page, renderer, cdp);
    seenTree.push(...descendants(host.pid));
    await cdp.detach().catch(() => undefined);
    // 放在最后：关窗会销毁 WebView，之后 --smoke-quit 也验证了宿主没有随窗口退出。
    await notifyAfterClose(renderer, n, code);
  } finally {
    await renderer.browser.close().catch(() => undefined);
  }
}

const executable = smokeHost();
const box = sandbox();
// 先拍 Run 快照再启动宿主：读不到就什么都不启动。
const loginItems = snapshotLoginItems([executable]);
// dataDir 给 N：CDP 端口文件在 N\webview，daemon.json 在 N\runtime（3.0 的文件都在新根）。
const host = startSmokeHost({ executable, dataDir: box.n, env: box.env });
let error: unknown;
try {
  await loginItems.restoreAfter(async () => {
    try {
      await run(host, box.n);
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
const hostLog = join(box.n, "logs", "host.log");
const rejectedLines = existsSync(hostLog)
  ? readFileSync(hostLog, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.includes("renderer message rejected"))
  : [];
const passed = error === undefined && log.failed.length === 0;
const report = {
  passed,
  executable,
  home: box.home,
  completedAt: new Date().toISOString(),
  checks: log.checks,
  hostRejectedMessages: rejectedLines.length,
  ...(error === undefined
    ? {}
    : { error: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
// 沙箱是固定名字的目录，下一次运行会先清掉；这里不留 WebView2 的大目录。
rmSync(box.home, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
if (!passed) process.exitCode = 1;
