import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";

type Run = (
  command: string,
  args: string[],
  options: { windowsHide: boolean },
) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;

/**
 * 把正式版交给用户的桌面 shell 去启动，而不是从当前进程直接拉起。
 *
 * 发布脚本跑在 Agent 的终端里。直接 spawn（哪怕 detached）的子进程会继承启动者所在的
 * 全部 Job——libuv 的 detached 不带 CREATE_BREAKAWAY_FROM_JOB——宿主一关，正式版跟着
 * 被结束；它还会继承宿主的环境变量（CLAUDECODE、会话消息管道与令牌等），常驻进程不该
 * 带着这些。本机用 kill-on-close Job 建模实测过：直接拉起的随 Job 结束，经 explorer
 * 拉起的由桌面 shell 当父进程、不在 Job 里、存活（ATM-T-0479）。
 *
 * explorer.exe 把启动转交给正在运行的 shell 后立即返回，**成功时退出码也是 1**，
 * 所以这里只认「进程没起来」这一种失败；是否真的启动成功由调用方等运行实例来判定。
 * 它不能可靠地转交命令行参数，因此只用于无参数的启动桩（与开始菜单快捷方式一致）。
 */
export function launchThroughShell(executable: string, run: Run = spawnSync): void {
  const result = run("explorer.exe", [executable], { windowsHide: true });
  if (result.error) throw new Error(`SHELL_LAUNCH_FAILED: ${result.error.message}`);
}

/**
 * 回落：直接从当前进程拉起。实例会留在 Agent 宿主的 Job 里并带着它的环境，
 * 调用方必须提示用户从开始菜单重启。
 */
export function launchDirect(executable: string): void {
  spawn(executable, [], { detached: true, stdio: "ignore" }).unref();
}
