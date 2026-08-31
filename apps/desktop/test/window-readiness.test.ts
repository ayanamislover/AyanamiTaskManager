import { describe, expect, it } from "vitest";
import { WindowReadinessGate } from "../src/window-readiness.js";

describe("桌面窗口渲染就绪门控", () => {
  it("前台启动要等原生窗口和 React 渲染器都就绪后才显示", () => {
    const gate = new WindowReadinessGate();
    gate.reset(true);

    expect(gate.markWindowReady()).toBeNull();
    expect(gate.markRendererReady()).toEqual({ show: true, route: null });
  });

  it("早到的唤醒只排队，不暴露空白窗口", () => {
    const gate = new WindowReadinessGate();
    gate.reset(false);

    expect(gate.requestShow()).toBeNull();
    expect(gate.markWindowReady()).toBeNull();
    expect(gate.markRendererReady()).toEqual({ show: true, route: null });
  });

  it("导航在就绪前只保留最新目标，就绪后一次性显示并派发", () => {
    const gate = new WindowReadinessGate();
    gate.reset(false);

    expect(gate.requestNavigation("quick")).toBeNull();
    expect(gate.requestNavigation("settings")).toBeNull();
    expect(gate.markRendererReady()).toBeNull();
    expect(gate.markWindowReady()).toEqual({ show: true, route: "settings" });
    expect(gate.requestShow()).toEqual({ show: true, route: null });
  });

  it("后台启动就绪后仍保持隐藏，直到收到显式唤醒", () => {
    const gate = new WindowReadinessGate();
    gate.reset(false);

    expect(gate.markWindowReady()).toBeNull();
    expect(gate.markRendererReady()).toBeNull();
    expect(gate.requestShow()).toEqual({ show: true, route: null });
  });
});
