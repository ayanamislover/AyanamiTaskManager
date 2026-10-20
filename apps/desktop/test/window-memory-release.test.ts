import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowMemoryRelease } from "../src/window-memory-release.js";

afterEach(() => {
  vi.useRealTimers();
});

// 关窗后界面用过的内存（项目库连接与 SQLite 页缓存、V8 堆）要还回去（ATM-T-0523）。
describe("关窗后释放内存", () => {
  it("关窗后等一会儿释放一次；期间窗口又开了就不释放", () => {
    vi.useFakeTimers();
    const release = vi.fn();
    const memory = new WindowMemoryRelease({ delayMs: 5_000, release });
    memory.windowClosed();
    vi.advanceTimersByTime(4_999);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledTimes(1);

    memory.windowClosed();
    vi.advanceTimersByTime(3_000);
    memory.windowShown();
    vi.advanceTimersByTime(10_000);
    expect(release).toHaveBeenCalledTimes(1);

    // 连关两次只释放一次；关闭进程时取消。
    memory.windowClosed();
    memory.windowClosed();
    vi.advanceTimersByTime(5_000);
    expect(release).toHaveBeenCalledTimes(2);
    memory.windowClosed();
    memory.cancel();
    vi.advanceTimersByTime(10_000);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("core 收到宿主的开关窗事件就驱动它，释放时让各连接还页缓存并做完整 GC；3.0 宿主不再起带 GC 开关的 Node", () => {
    const core = readFileSync("apps/desktop/src/core-main.ts", "utf8");
    expect(core).toContain("windowMemory.windowShown();");
    expect(core).toContain("windowMemory.windowClosed();");
    expect(core).toContain("windowMemory.cancel();");
    expect(core).toContain("runtime?.service.databases.releaseMemory();");
    expect(core).toContain("(globalThis as { gc?: () => void }).gc?.();");
    // 3.0（W8a）：服务在宿主进程里，关窗释放内存由 Rust 的 MemoryRelease 作业做；宿主的布局里没有 Node 入口，
    // CLI 是 atm.exe（W6a）。
    const paths = readFileSync("apps/desktop/native/host/src/paths.rs", "utf8");
    expect(paths).not.toMatch(/CORE_NODE_FLAGS|--expose-gc|node_entry|with_core_flags/u);
    expect(paths).toContain("cli: cli_entry(&app_dir, true),");
    expect(paths).not.toContain("cli.mjs");
  });
});
