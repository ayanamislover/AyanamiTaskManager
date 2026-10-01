import type { ChildProcess } from "node:child_process";
import { defaultProcessIdentity, isPidAlive, killProcessTree, type KillResult } from "./process.js";

/**
 * 进程相关的系统调用都走这里，测试注入替身（不向真实 PID 发信号、不真查系统）。
 * `identity` 返回进程的出生标识（见 process.ts 的 defaultProcessIdentity），查不到返回 null。
 */
export type ProcessProbe = {
  isAlive(pid: number): boolean;
  identity(pid: number): Promise<string | null>;
  killTree(pid: number): Promise<KillResult>;
};

export const defaultProcessProbe: ProcessProbe = {
  isAlive: isPidAlive,
  identity: defaultProcessIdentity,
  killTree: killProcessTree,
};

/**
 * - `same`：PID 还活着，且出生标识与记录**逐字相同**——仍是当初那个会话进程；
 * - `gone`：PID 已经不在；
 * - `different`：PID 活着但出生标识不同——原进程已退出、PID 被别的进程复用；
 * - `unknown`：PID 活着，但记录里没有标识（含旧版本只存了 ISO 创建时间的记录）或这次查不到——
 *   身份无法确认，不能接管也不能结束。
 */
export type ProcessIdentity = "same" | "gone" | "different" | "unknown";

/**
 * 只凭 PID + 出生标识判断身份，精确相等，没有任何时间容差：同一进程两次读到的标识必然相同，
 * 差 1 个 100ns 也说明是另一个进程。不看日志（日志里有没有 result 行证明不了 PID 归属）。
 */
export async function checkProcessIdentity(
  probe: ProcessProbe,
  pid: number,
  recorded: string | undefined,
): Promise<ProcessIdentity> {
  if (!probe.isAlive(pid)) return "gone";
  if (recorded === undefined || recorded === "") return "unknown";
  const actual = await probe.identity(pid).catch(() => null);
  if (actual === null) return probe.isAlive(pid) ? "unknown" : "gone";
  return actual === recorded ? "same" : "different";
}

/** 句柄说子进程还没退出（exit 事件没来）。Node 持有句柄期间系统不会把这个 PID 分给别的进程。 */
export function childRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * spawn 之后立刻向 OS 要这个 PID 的出生标识，存进记录供宿主重启后核验身份。
 * 只有查询结束时句柄仍说子进程没退出，才能确定查到的是自己的进程（期间 PID 不可能被复用）；
 * 否则、或查不到时返回 null（记为未知：重启后不会接管）。
 */
export async function captureIdentity(
  probe: ProcessProbe,
  child: ChildProcess,
): Promise<string | null> {
  const pid = child.pid;
  if (pid === undefined || !childRunning(child)) return null;
  const identity = await probe.identity(pid).catch(() => null);
  if (identity === null || identity === "" || !childRunning(child)) return null;
  return identity;
}
