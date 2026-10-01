import type { ChildProcess } from "node:child_process";
import {
  defaultProcessStartTime,
  isPidAlive,
  killProcessTree,
  type KillResult,
} from "./process.js";

/**
 * 「记录里的创建时间」与「OS 现查的创建时间」允许的差。
 *
 * 两个值出自同一个探测（Windows：Get-Process 的 StartTime，100ns 精度，同一进程两次读到的值相同；
 * 其它平台：`ps -o lstart=`，秒级，按开机时间推算，跨秒边界时可能差 1 秒），容差只用来吸收这点精度差，
 * 不是用宽松时间窗代替身份：PID 只有在原进程退出后才会被复用，新进程的创建时间必然晚于原进程；
 * 会话进程都要活好几秒（读 stdin、连 API），1 秒内「原进程退出 + PID 被复用」的组合可以排除。
 */
export const PROCESS_IDENTITY_TOLERANCE_MS = 1_000;

/** 进程相关的系统调用都走这里，测试注入替身（不向真实 PID 发信号、不真查创建时间）。 */
export type ProcessProbe = {
  isAlive(pid: number): boolean;
  /** 查不到（进程不在、探测超时或失败）返回 null。 */
  startTime(pid: number): Promise<Date | null>;
  killTree(pid: number): Promise<KillResult>;
};

export const defaultProcessProbe: ProcessProbe = {
  isAlive: isPidAlive,
  startTime: defaultProcessStartTime,
  killTree: killProcessTree,
};

/**
 * - `same`：PID 还活着，且创建时间与记录一致——仍是当初那个会话进程；
 * - `gone`：PID 已经不在；
 * - `different`：PID 活着但创建时间对不上——原进程已退出、PID 被别的进程复用；
 * - `unknown`：PID 活着，但记录里没有创建时间或这次查不到——身份无法确认，不能接管也不能结束。
 */
export type ProcessIdentity = "same" | "gone" | "different" | "unknown";

/** 只凭 PID + 创建时间判断身份；不看日志（日志里有没有 result 行证明不了 PID 归属）。 */
export async function checkProcessIdentity(
  probe: ProcessProbe,
  pid: number,
  recordedCreatedAt: string | undefined,
): Promise<ProcessIdentity> {
  if (!probe.isAlive(pid)) return "gone";
  const expected = recordedCreatedAt === undefined ? Number.NaN : Date.parse(recordedCreatedAt);
  if (Number.isNaN(expected)) return "unknown";
  const actual = await probe.startTime(pid).catch(() => null);
  if (actual === null) return probe.isAlive(pid) ? "unknown" : "gone";
  return Math.abs(actual.getTime() - expected) <= PROCESS_IDENTITY_TOLERANCE_MS
    ? "same"
    : "different";
}

/** 句柄说子进程还没退出（exit 事件没来）。Node 持有句柄期间系统不会把这个 PID 分给别的进程。 */
export function childRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * spawn 之后立刻向 OS 要这个 PID 的创建时间，存进记录供宿主重启后核验身份。
 * 只有查询结束时句柄仍说子进程没退出，才能确定查到的是自己的进程（期间 PID 不可能被复用）；
 * 否则、或查不到时返回 null（记为未知：重启后不会接管）。
 */
export async function captureCreatedAt(
  probe: ProcessProbe,
  child: ChildProcess,
): Promise<string | null> {
  const pid = child.pid;
  if (pid === undefined || !childRunning(child)) return null;
  const created = await probe.startTime(pid).catch(() => null);
  if (created === null || !childRunning(child)) return null;
  return created.toISOString();
}
