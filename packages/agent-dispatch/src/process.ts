import { execFile } from "node:child_process";

/** `process.kill(pid, 0)` 只探测不发信号；EPERM 说明进程在但不归我们管，也算活着。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 15_000, windowsHide: true, encoding: "utf8", ...(env ? { env } : {}) },
      (error, stdout) => resolve(error ? null : String(stdout).trim()),
    );
  });
}

/**
 * 进程创建时间，用来识别 PID 复用（Windows 上 PID 很快会被新进程拿去用）。
 * Windows 用 PowerShell 的 Get-Process，其它平台用 `ps -o lstart=`；拿不到返回 null。
 */
export async function defaultProcessStartTime(pid: number): Promise<Date | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const text =
    process.platform === "win32"
      ? await run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ])
      : await run("ps", ["-o", "lstart=", "-p", String(pid)], { ...process.env, LC_ALL: "C" });
  if (!text) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * 结束整棵进程树：Windows 用 `taskkill /PID <pid> /T /F`（参数数组），
 * 其它平台向进程组发 SIGTERM（子进程是 detached 起的，自成一组）。进程已不在时静默返回。
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 已经退出。
    }
  }
}
