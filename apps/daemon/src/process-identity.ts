import { spawnSync } from "node:child_process";
import { join } from "node:path";

export type ProcessIdentity = { createdAtTicks: string; startedAtMs: number };

let selfIdentity: ProcessIdentity | null = null;

/** Read only process birth time, never WMI or a serialized Process/.NET object graph. */
export function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform !== "win32") return null;
  if (pid === process.pid && selfIdentity) return selfIdentity;
  if (!process.env.SystemRoot) return null;
  const shell = join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    const result = spawnSync(
      shell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; try { $birth=(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime(); [Console]::WriteLine($birth.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)); [Console]::WriteLine(([DateTimeOffset]$birth).ToUnixTimeMilliseconds().ToString([Globalization.CultureInfo]::InvariantCulture)) } catch { exit 1 }`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1024 },
    );
    if (result.status !== 0 || result.error) return null;
    const [ticks, milliseconds] = result.stdout.trim().split(/\r?\n/u);
    if (!ticks || !/^\d{17,19}$/u.test(ticks) || !milliseconds || !/^\d{1,16}$/u.test(milliseconds))
      return null;
    const identity = { createdAtTicks: ticks, startedAtMs: Number(milliseconds) };
    if (!Number.isSafeInteger(identity.startedAtMs) || identity.startedAtMs <= 0) return null;
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
