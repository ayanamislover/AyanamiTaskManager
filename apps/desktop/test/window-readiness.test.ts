import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RENDERER_READY_TIMEOUT_MS, WindowReadinessGate } from "../src/window-readiness.js";

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

  it("渲染器不会再报到时放行，否则托盘和第二实例永远唤不醒窗口", () => {
    const gate = new WindowReadinessGate();
    gate.reset(true);
    gate.markWindowReady();

    // 放行前：所有唤醒入口都是空操作，用户没有任何出路。
    expect(gate.requestShow()).toBeNull();
    expect(gate.requestNavigation("settings")).toBeNull();

    expect(gate.markRendererUnavailable()).toEqual({ show: true, route: "settings" });
    expect(gate.abandoned).toBe(true);
  });

  it("后台启动放行后仍然保持隐藏，只是把托盘变回可用", () => {
    const gate = new WindowReadinessGate();
    gate.reset(false);
    gate.markWindowReady();

    // 放行不等于弹窗：没人请求显示就不该冒出一个窗口。
    expect(gate.markRendererUnavailable()).toBeNull();
    expect(gate.requestShow()).toEqual({ show: true, route: null });
  });

  it("原生窗口还没就绪时放行也不显示，避免又出现空白窗口", () => {
    const gate = new WindowReadinessGate();
    gate.reset(true);

    expect(gate.markRendererUnavailable()).toBeNull();
    expect(gate.markWindowReady()).toEqual({ show: true, route: null });
  });

  it("渲染器已经报到后，迟到的超时兜底是空操作", () => {
    const gate = new WindowReadinessGate();
    gate.reset(false);
    gate.markWindowReady();
    gate.markRendererReady();

    expect(gate.markRendererUnavailable()).toBeNull();
    expect(gate.abandoned).toBe(false);
  });

  it("重建窗口会清掉上一次的放行状态", () => {
    const gate = new WindowReadinessGate();
    gate.reset(true);
    gate.markWindowReady();
    gate.markRendererUnavailable();
    expect(gate.abandoned).toBe(true);

    gate.reset(true);
    expect(gate.abandoned).toBe(false);
    expect(gate.markWindowReady()).toBeNull();
  });

  it("兜底上限留足正常冷启动的余量，又不至于让用户干等", () => {
    expect(RENDERER_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(RENDERER_READY_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});

describe("窗口宿主接上了放行通道", () => {
  // 门控的逻辑由上面的用例钉住，但真正让应用打不开的是「三条兜底通道有没有接上」。
  // 少接任何一条，渲染器不报到时窗口就再也出不来，而纯状态机用例照样全绿。
  const source = readFileSync(
    join(process.cwd(), "apps", "desktop", "src", "window-host.ts"),
    "utf8",
  );

  it("建窗口时武装等待上限", () => {
    expect(source).toContain("armRendererReadyTimeout(this.mainWindow)");
  });

  it("加载失败与渲染进程退出都会放行", () => {
    expect(source).toContain('"did-fail-load"');
    expect(source).toContain('"render-process-gone"');
  });

  it("三条通道最终都落到同一个放行入口", () => {
    expect(source).toContain("markRendererUnavailable()");
  });
});
