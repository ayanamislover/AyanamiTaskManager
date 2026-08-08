import { describe, expect, it } from "vitest";
import { normalizeNotificationMode, shouldNotify } from "../src/notification-policy.js";

describe("桌面系统通知三档策略", () => {
  it("优先读取新三档值，并兼容旧布尔开关", () => {
    expect(normalizeNotificationMode("CRITICAL", true)).toBe("CRITICAL");
    expect(normalizeNotificationMode(undefined, true)).toBe("ALL");
    expect(normalizeNotificationMode(undefined, false)).toBe("OFF");
    expect(normalizeNotificationMode("invalid", undefined)).toBe("ALL");
  });

  it("全部通知覆盖所有受支持事件", () => {
    for (const event of [
      "work.waiting",
      "work.blocked",
      "work.completed",
      "agent.recovered_stale",
      "backup.failed",
    ]) {
      expect(shouldNotify("ALL", event)).toBe(true);
    }
    expect(shouldNotify("ALL", "work.updated")).toBe(false);
  });

  it("仅严重事件过滤等待和完成，不通知模式过滤全部", () => {
    expect(shouldNotify("CRITICAL", "work.waiting")).toBe(false);
    expect(shouldNotify("CRITICAL", "work.completed")).toBe(false);
    expect(shouldNotify("CRITICAL", "work.blocked")).toBe(true);
    expect(shouldNotify("CRITICAL", "agent.recovered_stale")).toBe(true);
    expect(shouldNotify("CRITICAL", "backup.failed")).toBe(true);
    expect(shouldNotify("OFF", "backup.failed")).toBe(false);
  });
});
