import { HOST_ONLINE_WINDOW_MS, type DeviceDoc, type HeadDoc } from "@ayanami-task/sync-protocol";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function parse(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:mm / N 天前 / M月D日。
 * 手机与电脑的时钟可能差几秒到几分钟，「未来」的时间一律当作刚刚。
 */
export function formatRelative(value: string | null | undefined, now: number = Date.now()): string {
  const time = parse(value);
  if (time === null) return "暂无";
  const delta = now - time;
  if (delta < 45_000) return "刚刚";
  if (delta < HOUR) return `${Math.max(1, Math.round(delta / MINUTE))} 分钟前`;
  const today = startOfDay(now);
  if (time >= today) return `${Math.floor(delta / HOUR)} 小时前`;
  if (time >= today - DAY) {
    const date = new Date(time);
    return `昨天 ${two(date.getHours())}:${two(date.getMinutes())}`;
  }
  if (delta < 7 * DAY) return `${Math.max(2, Math.round((today - startOfDay(time)) / DAY))} 天前`;
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 时间线里的绝对时间：今天只写 HH:mm，其余写 M/D HH:mm。 */
export function formatClock(value: string | null | undefined, now: number = Date.now()): string {
  const time = parse(value);
  if (time === null) return "--:--";
  const date = new Date(time);
  const clock = `${two(date.getHours())}:${two(date.getMinutes())}`;
  if (time >= startOfDay(now)) return clock;
  return `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

export type HostPresence = {
  online: boolean;
  /** 电脑最后一次留下痕迹的时间（在线状态文档或快照），都没有时为 null。 */
  lastSeen: string | null;
};

/**
 * 电脑在线判定（docs/mobile-sync.md §5）：电脑启动、每 5 分钟、正常退出各写一次在线状态，
 * 7 分钟内有痕迹就算在线。快照头部的 `at` 也是电脑写的，比在线状态新时同样算数；
 * 但电脑正常退出时写的 offline 若不早于快照，就以它为准。
 */
export function hostPresence(
  device: DeviceDoc | null | undefined,
  head: HeadDoc | null | undefined,
  now: number = Date.now(),
): HostPresence {
  const deviceAt = parse(device?.at);
  const headAt = parse(head?.at);
  const candidates = [deviceAt, headAt].filter((value): value is number => value !== null);
  if (candidates.length === 0) return { online: false, lastSeen: null };
  const last = Math.max(...candidates);
  const lastSeen = new Date(last).toISOString();
  if (device?.state === "offline" && deviceAt !== null && (headAt === null || deviceAt >= headAt)) {
    return { online: false, lastSeen };
  }
  return { online: now - last <= HOST_ONLINE_WINDOW_MS, lastSeen };
}
