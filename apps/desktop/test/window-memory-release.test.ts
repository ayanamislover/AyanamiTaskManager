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

  it("core 收到宿主的开关窗事件就驱动它，释放时让各连接还页缓存并做完整 GC；宿主只给 core 开 GC", () => {
    const core = readFileSync("apps/desktop/src/core-main.ts", "utf8");
    expect(core).toContain("windowMemory.windowShown();");
    expect(core).toContain("windowMemory.windowClosed();");
    expect(core).toContain("windowMemory.cancel();");
    expect(core).toContain("runtime?.service.databases.releaseMemory();");
    expect(core).toContain("(globalThis as { gc?: () => void }).gc?.();");
    const paths = readFileSync("apps/desktop/native/host/src/paths.rs", "utf8");
    expect(paths).toContain('const CORE_NODE_FLAGS: [&str; 1] = ["--expose-gc"];');
    expect(paths).toContain("core: with_core_flags(node_entry(&node, packaged_core, Vec::new())),");
    expect(paths).toContain(
      'cli: node_entry(&node, app_dir.join("runtime").join("cli.mjs"), Vec::new()),',
    );
  });
});
