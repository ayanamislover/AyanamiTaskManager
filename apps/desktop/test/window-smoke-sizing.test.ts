import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_SIZE,
  MINIMUM_WINDOW_SIZE,
  expectedInitialWindowSize,
  initialWindowSizeAcceptable,
  logicalWindowSize,
  windowSizeMatches,
} from "../../../scripts/window-smoke-sizing.js";

describe("窗口烟测初始尺寸验收", () => {
  it("契约与原生宿主 ensure_window 一致：默认 1440×900、最小 1100×680", () => {
    expect(DEFAULT_WINDOW_SIZE).toEqual({ width: 1440, height: 900 });
    expect(MINIMUM_WINDOW_SIZE).toEqual({ width: 1100, height: 680 });
  });

  it("显示器容得下默认窗口时严格要求 1440×900", () => {
    expect(expectedInitialWindowSize({ width: 1920, height: 1080 })).toEqual(DEFAULT_WINDOW_SIZE);
    expect(
      initialWindowSizeAcceptable({ width: 1440, height: 900 }, { width: 3440, height: 1440 }),
    ).toBe(true);
    expect(
      initialWindowSizeAcceptable({ width: 1920, height: 1080 }, { width: 3440, height: 1440 }),
    ).toBe(false);
  });

  it("放不下默认尺寸时只做区间检查：不小于最小尺寸、不超出显示器", () => {
    const display = { width: 1280, height: 800 };
    expect(expectedInitialWindowSize(display)).toBeNull();
    expect(initialWindowSizeAcceptable({ width: 1280, height: 800 }, display)).toBe(true);
    expect(initialWindowSizeAcceptable({ width: 1000, height: 800 }, display)).toBe(false);
    expect(initialWindowSizeAcceptable({ width: 1440, height: 900 }, display)).toBe(false);
  });

  it("工作区比最小尺寸还小时，最小窗口仍算合格", () => {
    expect(
      initialWindowSizeAcceptable({ width: 1100, height: 680 }, { width: 1024, height: 600 }),
    ).toBe(true);
  });

  it("物理像素按 DPI 换成逻辑像素", () => {
    expect(logicalWindowSize({ width: 2160, height: 1350 }, 144)).toEqual({
      width: 1440,
      height: 900,
    });
  });

  it("只容忍 Windows 原生边界计算产生的少量像素差", () => {
    const expected = { width: 1280, height: 796 };
    expect(windowSizeMatches({ width: 1282, height: 797 }, expected)).toBe(true);
    expect(windowSizeMatches({ width: 1290, height: 797 }, expected)).toBe(false);
  });
});
