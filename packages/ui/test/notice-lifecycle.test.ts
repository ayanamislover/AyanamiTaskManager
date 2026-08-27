import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelNoticeTimer, restartNoticeTimer } from "../src/notice-lifecycle.js";

describe("Notice timer lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a replacement notice its own complete 2800 ms lifetime", () => {
    vi.useFakeTimers();
    const timer = { current: null as number | null };
    let notice = "";
    const notify = (message: string) => {
      notice = message;
      restartNoticeTimer(timer, () => {
        notice = "";
      });
    };

    notify("first");
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1000);
    notify("second");
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1800);
    expect(notice).toBe("second");

    vi.advanceTimersByTime(999);
    expect(notice).toBe("second");

    vi.advanceTimersByTime(1);
    expect(notice).toBe("");
    expect(timer.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the pending callback when its owner unmounts", () => {
    vi.useFakeTimers();
    const timer = { current: null as number | null };
    const onElapsed = vi.fn();

    restartNoticeTimer(timer, onElapsed);
    cancelNoticeTimer(timer);

    expect(timer.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2800);
    expect(onElapsed).not.toHaveBeenCalled();
  });
});
