import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPresenceLifecycle } from "../src/components/presence.js";

describe("transient Presence lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("从未挂载进入 open，并在关闭期间缓存到 bounded fallback", () => {
    const lifecycle = createPresenceLifecycle(false, 320);
    expect(lifecycle.getSnapshot()).toBe("unmounted");

    lifecycle.setPresent(true);
    expect(lifecycle.getSnapshot()).toBe("open");

    lifecycle.setPresent(false);
    expect(lifecycle.getSnapshot()).toBe("closing");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(319);
    expect(lifecycle.getSnapshot()).toBe("closing");
    vi.advanceTimersByTime(1);
    expect(lifecycle.getSnapshot()).toBe("unmounted");
  });

  it("transitionend 立即完成退出并清掉 fallback，不重复通知", () => {
    const lifecycle = createPresenceLifecycle(true, 320);
    const listener = vi.fn();
    lifecycle.subscribe(listener);

    lifecycle.setPresent(false);
    lifecycle.finishExit();
    expect(lifecycle.getSnapshot()).toBe("unmounted");
    expect(vi.getTimerCount()).toBe(0);
    const calls = listener.mock.calls.length;
    lifecycle.finishExit();
    vi.runAllTimers();
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it("rapid close/reopen 可逆，旧 fallback 不会误卸载或双计时", () => {
    const lifecycle = createPresenceLifecycle(true, 320);
    lifecycle.setPresent(false);
    lifecycle.setPresent(false);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(120);
    lifecycle.setPresent(true);
    expect(lifecycle.getSnapshot()).toBe("open");
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(lifecycle.getSnapshot()).toBe("open");

    lifecycle.setPresent(false);
    expect(vi.getTimerCount()).toBe(1);
    lifecycle.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
