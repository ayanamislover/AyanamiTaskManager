import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

export type ProcessIdentity = { createdAtTicks: string; startedAtMs: number };

const QUERY_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 1024;

let selfIdentity: ProcessIdentity | null = null;
let selfPrefetch: Promise<void> | null = null;
let identityHelper: string | null = null;

/**
 * 有宿主时用宿主查（`AyanamiTaskManager.exe --process-identity <pid>`，宿主 identity.rs）：
 * 读的是同一个 GetProcessTimes，输出与 PowerShell 的 ticks 逐位相同，却不用每次起一个
 * powershell.exe（实测约 190 ms，冷启动时要起两个）。宿主给不出答案（起不来、不认这个参数、
 * 查不到）就退回 PowerShell：两边读的是同一份系统记录，只是慢一些。
 */
export function configureProcessIdentityHelper(executable: string | null): void {
  identityHelper = executable;
}

function powershellPath(): string | null {
  if (process.platform !== "win32" || !process.env.SystemRoot) return null;
  return join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

type IdentityQuery = { command: string; args: string[] };

/** The helper first, PowerShell whenever the helper gives no answer. */
function identityQueries(pid: number): IdentityQuery[] {
  const queries: IdentityQuery[] = [];
  if (identityHelper)
    queries.push({ command: identityHelper, args: ["--process-identity", String(pid)] });
  const shell = powershellPath();
  if (shell) queries.push({ command: shell, args: queryArguments(pid) });
  return queries;
}

/** Shared by the sync and prefetch paths so the two can never query different things. */
function queryArguments(pid: number): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$ErrorActionPreference='Stop'; try { $birth=(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime(); [Console]::WriteLine($birth.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)); [Console]::WriteLine(([DateTimeOffset]$birth).ToUnixTimeMilliseconds().ToString([Globalization.CultureInfo]::InvariantCulture)) } catch { exit 1 }`,
  ];
}

/** First two lines: ticks, Unix ms. The helper adds the image path as a third, unused here. */
function parseIdentity(stdout: string): ProcessIdentity | null {
  const [ticks, milliseconds] = stdout.trim().split(/\r?\n/u);
  if (!ticks || !/^\d{17,19}$/u.test(ticks) || !milliseconds || !/^\d{1,16}$/u.test(milliseconds))
    return null;
  const identity = { createdAtTicks: ticks, startedAtMs: Number(milliseconds) };
  if (!Number.isSafeInteger(identity.startedAtMs) || identity.startedAtMs <= 0) return null;
  return identity;
}

/**
 * 在阻塞用到之前，先把自身进程的出生时间算好。
 *
 * acquireDaemonRuntime 是同步的，写锁文件时必须当场拿到这个值，所以那里是一次
 * spawnSync(powershell.exe)——实测 166–266ms（p50 约 175ms），而窗口显示排在它后面，
 * 每次启动都被推迟这么多。开机自启碰上杀软扫 powershell.exe 时只会更糟，超时上限是 5 秒。
 *
 * 这里在进程刚起来时用异步 spawn 把同一个值算好放进缓存，和 app.whenReady()、
 * 随机登录延迟这些本来就要等的事情重叠。等真正用到时多半已经就位，同步那条路直接命中
 * 缓存返回；没就位就照旧走 spawnSync，行为完全不变。
 *
 * 为什么不干脆用 Date.now() - process.uptime()*1000 自己算、彻底不 spawn：那个值和
 * PowerShell 报的对不上，实测差 32ms，ticks 必然不等。而锁文件里记的是自己的身份，
 * 别的进程回头是用 PowerShell 查同一个 PID 来跟它比对的（isDifferentProcess 按 ticks
 * 字符串精确比）。两边口径一旦不同，一个活着的持锁者就会被判成「另一个进程」而被抢锁。
 * 要走那条路就得把比较改成带容差的，那是另一个决定，不能顺手做掉。
 */
export function prefetchSelfProcessIdentity(): Promise<void> {
  if (selfPrefetch) return selfPrefetch;
  const queries = identityQueries(process.pid);
  if (selfIdentity || queries.length === 0) {
    selfPrefetch = Promise.resolve();
    return selfPrefetch;
  }
  // 预取失败绝不能让启动失败：拿不到就退回同步那条路，和以前一样。
  selfPrefetch = queryAsync(queries).then((identity) => {
    if (identity) selfIdentity ??= identity;
  });
  return selfPrefetch;
}

/** The identity from the first query that gives one; null when none does. */
function queryAsync(queries: readonly IdentityQuery[]): Promise<ProcessIdentity | null> {
  const [query, ...fallbacks] = queries;
  if (!query) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(query.command, query.args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(queryAsync(fallbacks));
      return;
    }
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => child.kill(), QUERY_TIMEOUT_MS);
    const finish = (identity: ProcessIdentity | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(identity ?? queryAsync(fallbacks));
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? parseIdentity(stdout) : null));
  });
}

/** Read only process birth time, never WMI or a serialized Process/.NET object graph. */
export function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform !== "win32") return null;
  if (pid === process.pid && selfIdentity) return selfIdentity;
  for (const query of identityQueries(pid)) {
    try {
      const result = spawnSync(query.command, query.args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: QUERY_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      const identity = result.status === 0 && !result.error ? parseIdentity(result.stdout) : null;
      // No answer this way (missing helper, process gone, access denied): ask the next way.
      if (!identity) continue;
      if (pid === process.pid) selfIdentity = identity;
      return identity;
    } catch {
      // Access denied / missing PowerShell / timeout must not evict an apparently live owner.
      continue;
    }
  }
  return null;
}

/** Called only after checking that the PID is alive. Unknown identity retains the lock. */
export function isDifferentProcess(
  recorded: unknown,
  observed: ProcessIdentity | null,
  lockModifiedAt: number,
): boolean {
  if (!observed) return false;
  if (recorded && typeof recorded === "object" && "createdAtTicks" in recorded) {
    const ticks = recorded.createdAtTicks;
    if (typeof ticks !== "string" || !/^\d{17,19}$/u.test(ticks)) return false;
    return ticks !== observed.createdAtTicks;
  }
  // Legacy v1.0.26 locks have no birth identity. A process born after the lock cannot own it.
  // Allow filesystem millisecond rounding; ambiguous cases retain the lock.
  return Number.isFinite(lockModifiedAt) && observed.startedAtMs > lockModifiedAt + 2;
}
