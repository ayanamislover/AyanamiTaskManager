import { describe, expect, it, vi } from "vitest";
import {
  randomStartupDelayMs,
  shouldDelayStartup,
  STARTUP_DELAY_MAX_MS,
  STARTUP_DELAY_MIN_MS,
  waitForStartupDelay,
} from "../src/startup.js";

describe("Windows 随机延迟自启动", () => {
  it("生成包含首尾的有界延迟", () => {
    expect(randomStartupDelayMs(() => 0)).toBe(STARTUP_DELAY_MIN_MS);
    expect(randomStartupDelayMs(() => 1)).toBe(STARTUP_DELAY_MAX_MS);
    expect(randomStartupDelayMs(() => 0.5)).toBeGreaterThan(STARTUP_DELAY_MIN_MS);
    expect(randomStartupDelayMs(() => 0.5)).toBeLessThan(STARTUP_DELAY_MAX_MS);
  });

  it("只延迟带完整登录参数的非 smoke 后台启动", () => {
    expect(shouldDelayStartup(["--background", "--random-startup-delay"], false)).toBe(true);
    expect(shouldDelayStartup(["--background"], false)).toBe(false);
    expect(shouldDelayStartup(["--background", "--random-startup-delay"], true)).toBe(false);
  });

  it("第二实例可立即中断等待", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = waitForStartupDelay(30_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
