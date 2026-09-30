import { describe, expect, it, vi } from "vitest";
import { DesktopObserver } from "../src/desktop-observer.js";

type Listener = () => void;

function fakeService(initial: { mode?: unknown; legacy?: unknown } = {}) {
  const settings = new Map<string, unknown>();
  if (initial.mode !== undefined) settings.set("notification.mode", initial.mode);
  if (initial.legacy !== undefined) settings.set("notification.enabled", initial.legacy);
  const projectListeners = new Map<string, Listener>();
  let globalListener: Listener | null = null;
  const projectEvents = new Map<
    string,
    Array<{ seq: number; type: string; key: string; summary: string }>
  >();
  let globalEvents: Array<{ type: string; key: string; summary: string }> = [];
  const projects = [
    {
      code: "A",
      lifecycle: "ACTIVE",
      project_sequence: 0,
      blocked_count: 1,
      waiting_user_count: 2,
    },
    {
      code: "B",
      lifecycle: "ARCHIVED",
      project_sequence: 0,
      blocked_count: 5,
      waiting_user_count: 5,
    },
  ];
  const service = {
    databases: {
      getSetting<T>(key: string, fallback: T) {
        return { value: (settings.has(key) ? settings.get(key) : fallback) as T };
      },
    },
    setSetting: vi.fn((key: string, value: unknown) => settings.set(key, value)),
    overview: () => ({ sequence: 0, projects }),
    delta: vi.fn(async (code: string, since: number) => {
      const events = (projectEvents.get(code) ?? []).filter((event) => event.seq > since);
      return { events, hasMore: false };
    }),
    subscribeProject: vi.fn((code: string, listener: Listener) => {
      projectListeners.set(code, listener);
      return () => projectListeners.delete(code);
    }),
    subscribeGlobal: vi.fn((listener: Listener) => {
      globalListener = listener;
      return () => (globalListener = null);
    }),
    globalDelta: vi.fn(() => {
      const events = globalEvents;
      globalEvents = [];
      return { events, nextSequence: 1 };
    }),
  };
  return {
    service,
    projects,
    projectListeners,
    pushProject(code: string, event: { seq: number; type: string; key: string; summary: string }) {
      projectEvents.set(code, [...(projectEvents.get(code) ?? []), event]);
      projectListeners.get(code)?.();
    },
    pushGlobal(event: { type: string; key: string; summary: string }) {
      globalEvents.push(event);
      globalListener?.();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("关窗后仍在 core 里的通知与托盘", () => {
  it("只订阅 ACTIVE 项目；托盘计数只算已加载的概览，快照不变不重复推", async () => {
    const fake = fakeService();
    const trayChanged = vi.fn();
    const observer = new DesktopObserver({
      service: fake.service as never,
      pendingUpdate: () => null,
      notify: vi.fn(),
      trayChanged,
    });
    observer.start();
    expect([...fake.projectListeners.keys()]).toEqual(["A"]);
    expect(trayChanged).toHaveBeenLastCalledWith({
      blocked: 6,
      waiting: 7,
      pendingUpdate: null,
      notificationMode: "ALL",
    });
    const pushes = trayChanged.mock.calls.length;
    observer.refreshTray();
    expect(trayChanged.mock.calls.length).toBe(pushes);
    observer.stop();
    expect(fake.projectListeners.size).toBe(0);
  });

  it("同一事件十分钟内只通知一次；CRITICAL 模式不报完成；OFF 全静音", async () => {
    let now = 1_000_000;
    const fake = fakeService({ mode: "ALL" });
    const notify = vi.fn();
    const observer = new DesktopObserver({
      service: fake.service as never,
      pendingUpdate: () => null,
      notify,
      trayChanged: vi.fn(),
      now: () => now,
    });
    observer.start();
    fake.pushProject("A", { seq: 1, type: "work.blocked", key: "A-T-1", summary: "卡住了" });
    await flush();
    fake.pushProject("A", { seq: 2, type: "work.blocked", key: "A-T-1", summary: "又卡住了" });
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ title: "A · 任务受阻", body: "卡住了" });
    now += 10 * 60_000 + 1;
    fake.pushProject("A", { seq: 3, type: "work.blocked", key: "A-T-1", summary: "第三次" });
    await flush();
    expect(notify).toHaveBeenCalledTimes(2);

    observer.setNotificationMode("CRITICAL");
    fake.pushProject("A", { seq: 4, type: "work.completed", key: "A-T-2", summary: "完成" });
    await flush();
    expect(notify).toHaveBeenCalledTimes(2);

    observer.setNotificationMode("OFF");
    fake.pushGlobal({ type: "backup.failed", key: "b1", summary: "磁盘满" });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("备份失败全局去重；旧的 notification.enabled=false 等同 OFF", () => {
    const fake = fakeService();
    const notify = vi.fn();
    const observer = new DesktopObserver({
      service: fake.service as never,
      pendingUpdate: () => null,
      notify,
      trayChanged: vi.fn(),
    });
    observer.start();
    fake.pushGlobal({ type: "backup.failed", key: "b1", summary: "磁盘满" });
    fake.pushGlobal({ type: "backup.failed", key: "b1", summary: "磁盘满" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ title: "备份失败", body: "磁盘满" });

    const legacy = new DesktopObserver({
      service: fakeService({ legacy: false }).service as never,
      pendingUpdate: () => null,
      notify: vi.fn(),
      trayChanged: vi.fn(),
    });
    expect(legacy.notificationMode()).toBe("OFF");
  });
});
