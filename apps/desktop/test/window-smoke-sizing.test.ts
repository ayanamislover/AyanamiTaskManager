import { describe, expect, it } from "vitest";
import {
  expectedInitialWindowSize,
  windowSizeMatches,
} from "../../../scripts/window-smoke-sizing.js";

describe("窗口烟测初始尺寸验收", () => {
  it("显示器容得下默认窗口时仍严格要求 1920×1080", () => {
    expect(
      expectedInitialWindowSize({ width: 1920, height: 1080 }, { width: 1920, height: 1040 }),
    ).toEqual({ width: 1920, height: 1080 });
  });

  it("较小显示器按真实工作区验收，而不是误报产品回归", () => {
    expect(
      expectedInitialWindowSize({ width: 1280, height: 836 }, { width: 1280, height: 796 }),
    ).toEqual({ width: 1280, height: 796 });
  });

  it("工作区比应用最小尺寸更小时仍守住最小窗口契约", () => {
    expect(
      expectedInitialWindowSize({ width: 1024, height: 600 }, { width: 1024, height: 560 }),
    ).toEqual({ width: 1100, height: 680 });
  });

  it("只容忍 Windows 原生边界计算产生的少量像素差", () => {
    const expected = { width: 1280, height: 796 };
    expect(windowSizeMatches({ width: 1282, height: 797 }, expected)).toBe(true);
    expect(windowSizeMatches({ width: 1290, height: 797 }, expected)).toBe(false);
  });
});
