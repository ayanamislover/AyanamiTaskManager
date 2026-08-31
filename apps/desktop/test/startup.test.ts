import { describe, expect, it, vi } from "vitest";
import {
  AGENT_WAKE_ARGS,
  isAgentWakeRequest,
  LOGIN_ITEM_ARGS,
  loginItemExecutable,
  randomStartupDelayMs,
  shouldDelayStartup,
  shouldStartInBackground,
  STARTUP_DELAY_MAX_MS,
  STARTUP_DELAY_MIN_MS,
  waitForStartupDelay,
} from "../src/startup.js";

describe("Windows 随机延迟自启动", () => {
  it("把登录随机延迟限制在用户可感知的 5 秒内", () => {
    expect(STARTUP_DELAY_MIN_MS).toBe(0);
    expect(STARTUP_DELAY_MAX_MS).toBeLessThanOrEqual(5_000);
  });

  it("生成包含首尾的有界延迟", () => {
    expect(randomStartupDelayMs(() => 0)).toBe(STARTUP_DELAY_MIN_MS);
    expect(randomStartupDelayMs(() => 1)).toBe(STARTUP_DELAY_MAX_MS);
    expect(randomStartupDelayMs(() => 0.5)).toBeGreaterThan(STARTUP_DELAY_MIN_MS);
    expect(randomStartupDelayMs(() => 0.5)).toBeLessThan(STARTUP_DELAY_MAX_MS);
  });

  it("只延迟带完整登录参数的非 smoke 后台启动", () => {
    expect(shouldDelayStartup([...LOGIN_ITEM_ARGS], false)).toBe(true);
    expect(shouldDelayStartup(["--background"], false)).toBe(false);
    expect(shouldDelayStartup([...LOGIN_ITEM_ARGS], true)).toBe(false);
  });

  it("登录项固定以后台模式启动，普通启动与二次手动唤起保持前台", () => {
    expect(LOGIN_ITEM_ARGS).toEqual(["--background", "--random-startup-delay"]);
    expect(shouldStartInBackground([...LOGIN_ITEM_ARGS], false)).toBe(true);
    expect(shouldStartInBackground([], false)).toBe(false);
    expect(shouldStartInBackground([...LOGIN_ITEM_ARGS], true)).toBe(false);
  });

  it("Agent 唤醒使用独立后台意图，不会把随机延迟中的窗口拉到前台", () => {
    expect(AGENT_WAKE_ARGS).toEqual(["--background", "--agent-wake"]);
    expect(isAgentWakeRequest([...AGENT_WAKE_ARGS])).toBe(true);
    expect(isAgentWakeRequest(["--background"])).toBe(false);
    expect(shouldDelayStartup([...AGENT_WAKE_ARGS], false)).toBe(false);
    expect(shouldStartInBackground([...AGENT_WAKE_ARGS], false)).toBe(true);
  });

  it("登录项使用数据根下的版本无关入口，升级后不会钉死旧 app 目录", () => {
    expect(loginItemExecutable("C:\\Users\\me\\AppData\\Local\\AyanamiTaskManager")).toBe(
      "C:\\Users\\me\\AppData\\Local\\AyanamiTaskManager\\current\\AyanamiTaskManager.exe",
    );
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
