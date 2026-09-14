import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

export type ProcessIdentity = { createdAtTicks: string; startedAtMs: number };

const QUERY_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 1024;

let selfIdentity: ProcessIdentity | null = null;
let selfPrefetch: Promise<void> | null = null;

function powershellPath(): string | null {
  if (process.platform !== "win32" || !process.env.SystemRoot) return null;
  return join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
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
  const shell = powershellPath();
  if (selfIdentity || !shell) {
    selfPrefetch = Promise.resolve();
    return selfPrefetch;
  }
  selfPrefetch = new Promise<void>((resolve) => {
    let child;
    try {
      child = spawn(shell, queryArguments(process.pid), {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve();
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => child.kill(), QUERY_TIMEOUT_MS);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) selfIdentity ??= parseIdentity(stdout);
      resolve();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    // 预取失败绝不能让启动失败：拿不到就退回同步那条路，和以前一样。
    child.on("error", () => finish(null));
    child.on("close", finish);
  });
  return selfPrefetch;
}

/** Read only process birth time, never WMI or a serialized Process/.NET object graph. */
export function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform !== "win32") return null;
  if (pid === process.pid && selfIdentity) return selfIdentity;
  const shell = powershellPath();
  if (!shell) return null;
  try {
    const result = spawnSync(shell, queryArguments(pid), {
      encoding: "utf8",
      windowsHide: true,
      timeout: QUERY_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (result.status !== 0 || result.error) return null;
    const identity = parseIdentity(result.stdout);
    if (!identity) return null;
    if (pid === process.pid) selfIdentity = identity;
    return identity;
  } catch {
    // Access denied / missing PowerShell / timeout must not evict an apparently live owner.
    return null;
  }
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
