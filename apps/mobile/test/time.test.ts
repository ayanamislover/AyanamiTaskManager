import { describe, expect, it } from "vitest";
import type { DeviceDoc, HeadDoc } from "@ayanami-task/sync-protocol";
import { formatClock, formatRelative, hostPresence } from "../src/data/time.js";

// 用本地时间构造，避免跑用例的机器时区影响「今天 / 昨天」的判断。
const NOW = new Date(2026, 8, 30, 15, 30, 0).getTime();
const at = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();
const local = (month: number, day: number, hour: number, minute: number, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).toISOString();

describe("相对时间", () => {
  it("刚刚 / 分钟 / 小时 / 昨天 / 天 / 日期", () => {
    expect(formatRelative(at(10_000), NOW)).toBe("刚刚");
    expect(formatRelative(at(-120_000), NOW)).toBe("刚刚");
    expect(formatRelative(at(50_000), NOW)).toBe("1 分钟前");
    expect(formatRelative(at(5 * 60_000), NOW)).toBe("5 分钟前");
    expect(formatRelative(at(3 * 3_600_000), NOW)).toBe("3 小时前");
    expect(formatRelative(local(9, 29, 23, 5), NOW)).toBe("昨天 23:05");
    expect(formatRelative(local(9, 27, 8, 0), NOW)).toBe("3 天前");
    expect(formatRelative(local(9, 1, 8, 0), NOW)).toBe("9月1日");
    expect(formatRelative(local(12, 31, 8, 0, 2025), NOW)).toBe("2025年12月31日");
  });

  it("缺失或无法解析的时间", () => {
    expect(formatRelative(null, NOW)).toBe("暂无");
    expect(formatRelative("not-a-date", NOW)).toBe("暂无");
    expect(formatClock(undefined, NOW)).toBe("--:--");
  });

  it("时钟：今天只写时分，其他日子带月日", () => {
    expect(formatClock(local(9, 30, 9, 5), NOW)).toBe("09:05");
    expect(formatClock(local(9, 28, 18, 40), NOW)).toBe("9/28 18:40");
  });
});

function device(state: DeviceDoc["state"], offsetMs: number): DeviceDoc {
  return {
    v: 1,
    id: "pc-0123456789ab",
    name: "AYANAMI-PC",
    kind: "windows",
    role: "host",
    app: "atm/1.3.0",
    at: at(offsetMs),
    state,
  };
}

function head(offsetMs: number): HeadDoc {
  return {
    v: 1,
    host: { id: "pc-0123456789ab", name: "AYANAMI-PC", app: "atm/1.3.0" },
    at: at(offsetMs),
    dispatch: { enabled: true, mode: "auto", running: 0 },
    projects: [],
  };
}

describe("电脑在线判定（7 分钟）", () => {
  it("在线状态 7 分钟内算在线，超过算离线", () => {
    expect(hostPresence(device("online", 6 * 60_000), null, NOW).online).toBe(true);
    expect(hostPresence(device("online", 7 * 60_000 + 1), null, NOW).online).toBe(false);
  });

  it("快照比在线状态新时以快照为准", () => {
    const presence = hostPresence(device("online", 30 * 60_000), head(60_000), NOW);
    expect(presence).toEqual({ online: true, lastSeen: at(60_000) });
  });

  it("电脑正常退出写的 offline 不早于快照时判离线", () => {
    expect(hostPresence(device("offline", 60_000), head(120_000), NOW).online).toBe(false);
    // 退出后又重新发布了快照（重启了），快照更新就还算在线。
    expect(hostPresence(device("offline", 120_000), head(60_000), NOW).online).toBe(true);
  });

  it("什么都没有时离线且没有最后时间", () => {
    expect(hostPresence(null, null, NOW)).toEqual({ online: false, lastSeen: null });
  });
});
