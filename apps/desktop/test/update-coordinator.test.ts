import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installRootOf, scanUpdateFeed, UpdateCoordinator } from "../src/update-coordinator.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "atm-update-coordinator-"));
  created.push(dir);
  const root = join(dir, "install");
  const data = join(dir, "data");
  const feed = join(data, "updates");
  mkdirSync(join(root, "app-9.0.0"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(feed, { recursive: true });
  writeFileSync(join(root, "app.json"), JSON.stringify({ current: "9.0.0", previous: null }));
  return { root, data, feed };
}

/** 发布链的投递顺序：先包，后清单。 */
function deliver(feed: string, version: string, patch: Record<string, unknown> = {}, bytes = 64) {
  const zip = `atm-${version}-win-x64.zip`;
  writeFileSync(join(feed, zip), Buffer.alloc(bytes));
  const manifest = {
    format: 1,
    version,
    arch: "x64",
    package: zip,
    packageSha256: "0".repeat(64),
    packageBytes: bytes,
    ...patch,
  };
  writeFileSync(join(feed, `atm-${version}-win-x64.json`), JSON.stringify(manifest));
}

function coordinator(paths: ReturnType<typeof sandbox>, installRoot: string | null = paths.root) {
  const requestInstall = vi.fn<(manifest: string) => void>();
  const onUpdateReady = vi.fn<(version: string) => void>();
  const updates = new UpdateCoordinator({
    dataDir: paths.data,
    currentVersion: "9.0.0",
    installRoot,
    requestInstall,
    onUpdateReady,
  });
  return { updates, requestInstall, onUpdateReady };
}

/**
 * feed 里属于发布链的文件。其他进程可能在 feed 里短暂留下自己的东西（实测：扫描刚写入的
 * zip 时出现过大写的 `ATM-9.0.1-WIN-X64.ZIP.tmp`），那不归 coordinator 管，也不该让断言抖。
 */
function delivered(feed: string): string[] {
  return readdirSync(feed).filter((name) => name.startsWith("atm-"));
}

describe("本地更新源（原生包）", () => {
  it("挑最高的完整新版本；不高于当前版本的包与 Squirrel 遗留物算已消费", () => {
    const { feed } = sandbox();
    deliver(feed, "8.9.0");
    deliver(feed, "9.0.0");
    deliver(feed, "9.0.1");
    deliver(feed, "9.1.0");
    writeFileSync(join(feed, "RELEASES"), "x");
    writeFileSync(join(feed, "AyanamiTaskManager-1.2.2-full.nupkg"), "x");
    writeFileSync(join(feed, "notes.txt"), "x");
    const scan = scanUpdateFeed(feed, "9.0.0");
    expect(scan.candidate?.version).toBe("9.1.0");
    expect(scan.candidate?.manifest).toBe(join(feed, "atm-9.1.0-win-x64.json"));
    expect(scan.consumed.sort()).toEqual(
      [
        "AyanamiTaskManager-1.2.2-full.nupkg",
        "RELEASES",
        "atm-8.9.0-win-x64.json",
        "atm-8.9.0-win-x64.zip",
        "atm-9.0.0-win-x64.json",
        "atm-9.0.0-win-x64.zip",
      ].sort(),
    );
  });

  it("只有包没有清单：投递还没完成，不算有更新", () => {
    const { feed } = sandbox();
    writeFileSync(join(feed, "atm-9.0.1-win-x64.zip"), Buffer.alloc(8));
    expect(scanUpdateFeed(feed, "9.0.0")).toEqual({ candidate: null, invalid: null, consumed: [] });
  });

  it("清单与包对不上就是坏投递：报出来，不装", () => {
    for (const [patch, bytes, reason] of [
      [{ packageBytes: 65 }, 64, "PACKAGE_SIZE_MISMATCH"],
      [{ version: "9.0.2" }, 64, "MANIFEST_INVALID"],
      [{ package: "../atm-9.0.1-win-x64.zip" }, 64, "MANIFEST_INVALID"],
      [{ format: 2 }, 64, "MANIFEST_INVALID"],
    ] as const) {
      const { feed } = sandbox();
      deliver(feed, "9.0.1", patch, bytes);
      expect(scanUpdateFeed(feed, "9.0.0").invalid).toEqual({ version: "9.0.1", reason });
    }
    const { feed } = sandbox();
    deliver(feed, "9.0.1");
    rmSync(join(feed, "atm-9.0.1-win-x64.zip"));
    expect(scanUpdateFeed(feed, "9.0.0").invalid?.reason).toBe("PACKAGE_MISSING");
  });

  it("安装布局才参与更新：便携版、源码运行没有安装根", () => {
    const { root } = sandbox();
    expect(installRootOf(join(root, "app-9.0.0"), true)).toBe(root);
    expect(installRootOf(join(root, "app-9.0.0"), false)).toBeNull();
    expect(installRootOf(join(root, "portable"), true)).toBeNull();
    rmSync(join(root, "app.json"));
    expect(installRootOf(join(root, "app-9.0.0"), true)).toBeNull();
  });
});

describe("UpdateCoordinator", () => {
  it("发现新版本：只告知一次、托盘有待更新；定时检查绝不自己动手安装", async () => {
    const paths = sandbox();
    deliver(paths.feed, "9.0.1");
    const { updates, requestInstall, onUpdateReady } = coordinator(paths);
    const status = await updates.check();
    expect(status).toMatchObject({ code: "UPDATE_READY", outcome: "SUCCESS", version: "9.0.1" });
    expect(updates.pendingUpdate).toBe("9.0.1");
    await updates.check();
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    expect(requestInstall).not.toHaveBeenCalled();
  });

  it("用户点立即更新：重新确认后把清单交给宿主，状态停在 INSTALLING", async () => {
    const paths = sandbox();
    deliver(paths.feed, "9.0.1");
    const { updates, requestInstall } = coordinator(paths);
    await updates.check();
    const status = await updates.apply();
    expect(status).toMatchObject({ code: "INSTALLING", phase: "INSTALL", version: "9.0.1" });
    expect(requestInstall).toHaveBeenCalledExactlyOnceWith(
      join(paths.feed, "atm-9.0.1-win-x64.json"),
    );
  });

  it("包在点击前被删：不发起安装", async () => {
    const paths = sandbox();
    deliver(paths.feed, "9.0.1");
    const { updates, requestInstall } = coordinator(paths);
    await updates.check();
    rmSync(join(paths.feed, "atm-9.0.1-win-x64.json"));
    const status = await updates.apply();
    expect(requestInstall).not.toHaveBeenCalled();
    expect(status?.code).toBe("UPDATE_SOURCE_MISSING");
    expect(updates.pendingUpdate).toBeNull();
  });

  it("装好后的新版本：报「已更新」并清掉已消费的包", async () => {
    const paths = sandbox();
    deliver(paths.feed, "9.0.1");
    const before = coordinator(paths);
    await before.updates.apply();
    // setup 完成事务、新版本启动：core 的版本就是 9.0.1。
    writeFileSync(
      join(paths.root, "state", "install.json"),
      JSON.stringify({ id: "t1", to: "9.0.1", state: "DONE", outcome: "COMMITTED" }),
    );
    const after = new UpdateCoordinator({
      dataDir: paths.data,
      currentVersion: "9.0.1",
      installRoot: paths.root,
      requestInstall: vi.fn(),
      onUpdateReady: vi.fn(),
    });
    expect(await after.check()).toMatchObject({ code: "UPDATE_INSTALLED", version: "9.0.1" });
    expect(delivered(paths.feed)).toEqual([]);
  });

  it("新版本在 START 阶段就开始检查：事务未定时不报、不清包，定下来后再报", async () => {
    const paths = sandbox();
    deliver(paths.feed, "9.0.1");
    await coordinator(paths).updates.apply();
    const journal = join(paths.root, "state", "install.json");
    writeFileSync(journal, JSON.stringify({ id: "t1", to: "9.0.1", state: "START" }));
    const after = new UpdateCoordinator({
      dataDir: paths.data,
      currentVersion: "9.0.1",
      installRoot: paths.root,
      requestInstall: vi.fn(),
      onUpdateReady: vi.fn(),
    });
    expect(await after.check()).toMatchObject({ code: "INSTALLING" });
    expect(delivered(paths.feed).sort()).toEqual([
      "atm-9.0.1-win-x64.json",
      "atm-9.0.1-win-x64.zip",
    ]);
    writeFileSync(
      journal,
      JSON.stringify({ id: "t1", to: "9.0.1", state: "DONE", outcome: "COMMITTED" }),
    );
    expect(await after.check()).toMatchObject({ code: "UPDATE_INSTALLED" });
    expect(delivered(paths.feed)).toEqual([]);
    after.stop();
  });

  it("没装上：setup 把旧版本拉回来，旧版本报出失败原因", async () => {
    const paths = sandbox();
    deliver(paths.feed, "9.0.1");
    const first = coordinator(paths);
    await first.updates.apply();
    writeFileSync(
      join(paths.root, "state", "install.json"),
      JSON.stringify({ id: "t1", to: "9.0.1", state: "DONE", outcome: "ROLLED_BACK" }),
    );
    const again = coordinator(paths);
    const status = await again.updates.check();
    // 失败记录在前，随后这次检查照常给出「仍可更新」——包还在，用户可以再试。
    expect(status?.code).toBe("UPDATE_READY");
    const log = readdirSync(join(paths.data, "logs"));
    expect(log).toContain("updater.ndjson");
    const lines = (await import("node:fs"))
      .readFileSync(join(paths.data, "logs", "updater.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { code: string; message: string });
    expect(lines.map((line) => line.code)).toEqual([
      "UPDATE_READY",
      "INSTALLING",
      "INSTALL_FAILED",
      "UPDATE_READY",
    ]);
    expect(lines[2]!.message).toContain("ROLLED_BACK");
  });

  it("宿主没能拉起安装程序：记为安装失败", async () => {
    const paths = sandbox();
    deliver(paths.feed, "9.0.1");
    const { updates } = coordinator(paths);
    await updates.apply();
    updates.launchFailed();
    expect(updates.status()).toMatchObject({ code: "INSTALL_FAILED", outcome: "ERROR" });
  });

  it("便携版：不扫、不删、不发起", async () => {
    const paths = sandbox();
    deliver(paths.feed, "9.0.1");
    deliver(paths.feed, "1.0.0");
    const { updates, requestInstall } = coordinator(paths, null);
    expect(await updates.check()).toMatchObject({ code: "UPDATE_UNSUPPORTED" });
    await updates.apply();
    expect(requestInstall).not.toHaveBeenCalled();
    expect(existsSync(join(paths.feed, "atm-1.0.0-win-x64.zip"))).toBe(true);
  });

  it("并发检查合并成一次", async () => {
    const paths = sandbox();
    deliver(paths.feed, "9.0.1");
    const { updates, onUpdateReady } = coordinator(paths);
    const [a, b] = await Promise.all([updates.check(), updates.check()]);
    expect(a).toBe(b);
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });
});
