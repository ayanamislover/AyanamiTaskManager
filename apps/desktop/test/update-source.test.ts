import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  electronUpdateExe,
  parseSquirrelCheck,
  planUpdateCheck,
  pruneConsumedUpdateFeed,
  releaseFeedEntries,
  resolveUpdateExe,
  updateFeedReady,
} from "../src/updater.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function dataDirWithFeed(version: string): string {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-update-source-"));
  temporary.push(dataDir);
  const feed = join(dataDir, "updates");
  mkdirSync(feed, { recursive: true });
  const name = `AyanamiTaskManagerDesktop-${version}-full.nupkg`;
  writeFileSync(join(feed, name), "package", "utf8");
  writeFileSync(join(feed, "RELEASES"), `AAA ${name} 7\n`, "utf8");
  return dataDir;
}

describe("本地更新源与 Squirrel 运行器", () => {
  it("RELEASES 里解析出包名和版本号，逐段比数字", () => {
    expect(
      releaseFeedEntries("AAA AyanamiTaskManagerDesktop-1.0.27-full.nupkg 164693885\r\n\n"),
    ).toEqual([{ name: "AyanamiTaskManagerDesktop-1.0.27-full.nupkg", version: "1.0.27" }]);
    // 字符串比较会把 1.0.27 判成比 1.1.0 新。
    expect(compareVersions("1.1.0", "1.0.27")).toBe(1);
    expect(compareVersions("1.0.27", "1.1.0")).toBe(-1);
    expect(compareVersions("1.1", "1.1.0")).toBe(0);
    // 字符串比较在这两对上直接反向：'2' < '9'、'1' < '9'。
    expect(compareVersions("1.0.27", "1.0.9")).toBe(1);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
  });

  it("装完的本地更新自动清掉；还没装的和版本号认不出来的都留着", () => {
    const consumed = dataDirWithFeed("1.0.27");
    expect(pruneConsumedUpdateFeed(consumed, "1.1.0").sort()).toEqual([
      "AyanamiTaskManagerDesktop-1.0.27-full.nupkg",
      "RELEASES",
    ]);
    expect(updateFeedReady(consumed)).toBe(false);

    const pending = dataDirWithFeed("1.2.0");
    expect(pruneConsumedUpdateFeed(pending, "1.1.0")).toEqual([]);
    expect(updateFeedReady(pending)).toBe(true);

    const unknown = dataDirWithFeed("1.0.27");
    writeFileSync(join(unknown, "updates", "RELEASES"), "AAA weird-package.nupkg 7\n", "utf8");
    expect(pruneConsumedUpdateFeed(unknown, "1.1.0")).toEqual([]);

    const empty = mkdtempSync(join(tmpdir(), "atm-update-source-empty-"));
    temporary.push(empty);
    expect(pruneConsumedUpdateFeed(empty, "1.1.0")).toEqual([]);
  });

  it("穿透 current 链接找到真正的 Update.exe；两个位置都没有时返回 null", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-update-exe-"));
    temporary.push(root);
    const install = join(root, "AyanamiTaskManagerDesktop", "app-1.1.0");
    mkdirSync(install, { recursive: true });
    const realExe = join(install, "AyanamiTaskManager.exe");
    const realUpdate = join(root, "AyanamiTaskManagerDesktop", "Update.exe");
    writeFileSync(realExe, "exe", "utf8");
    writeFileSync(realUpdate, "update", "utf8");
    const linkedExe = join(root, "AyanamiTaskManager", "current", "AyanamiTaskManager.exe");

    // Electron 只看 execPath 上两级：经 current 链接启动时那里没有 Update.exe。
    expect(existsSync(electronUpdateExe(linkedExe))).toBe(false);
    expect(resolveUpdateExe(linkedExe, () => realExe)).toBe(realUpdate);
    expect(resolveUpdateExe(realExe, (path) => path)).toBe(realUpdate);
    expect(
      resolveUpdateExe(linkedExe, () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });

  it("检查计划：清理过、没有更新源、常规安装、经链接启动、完全找不到 Update.exe", () => {
    const base = {
      feedReady: true,
      consumed: [] as string[],
      electronRunnerReady: false,
      resolvedUpdateExe: null as string | null,
    };
    expect(planUpdateCheck({ ...base, consumed: ["RELEASES"] })).toMatchObject({
      kind: "SKIP",
      code: "UPDATE_SOURCE_CONSUMED",
    });
    expect(planUpdateCheck({ ...base, feedReady: false })).toMatchObject({
      kind: "SKIP",
      code: "UPDATE_SOURCE_MISSING",
    });
    expect(planUpdateCheck({ ...base, electronRunnerReady: true })).toEqual({ kind: "ELECTRON" });
    expect(planUpdateCheck({ ...base, resolvedUpdateExe: "U.exe" })).toEqual({
      kind: "SQUIRREL",
      updateExe: "U.exe",
    });
    // 以前这里会照样调 autoUpdater，于是每 6 小时记一条「Can not find Squirrel」安装失败。
    expect(planUpdateCheck(base)).toMatchObject({ kind: "SKIP", code: "UPDATE_RUNNER_MISSING" });
  });

  it("Update.exe --checkForUpdate 的输出取最后一行 JSON，噪声和坏 JSON 都不当成结果", () => {
    expect(
      parseSquirrelCheck(
        '33\r\n66\r\n100\r\n{"currentVersion":"1.1.0","futureVersion":"1.2.0","releasesToApply":[{"version":"1.2.0"}]}\r\n',
      ),
    ).toEqual({
      currentVersion: "1.1.0",
      futureVersion: "1.2.0",
      releasesToApply: [{ version: "1.2.0" }],
    });
    expect(parseSquirrelCheck("no json here")).toBeNull();
    expect(parseSquirrelCheck("{oops}")).toBeNull();
    expect(parseSquirrelCheck('{"currentVersion":"1.1.0"}')).toBeNull();
  });

  it("更新主机按计划走：先清消费完的 feed，再决定 autoUpdater 还是自己跑 Update.exe", () => {
    const source = readFileSync(
      resolve(process.cwd(), "apps", "desktop", "src", "update-host.ts"),
      "utf8",
    );
    for (const contract of [
      "pruneConsumedUpdateFeed(dataDir, version)",
      "planUpdateCheck({",
      'if (plan.kind === "SQUIRREL") return this.applyWithSquirrel(plan.updateExe);',
      "`--checkForUpdate=${feed}`",
      "`--update=${feed}`",
      "parseSquirrelCheck(checked.output)",
    ]) {
      expect(source).toContain(contract);
    }
    // 检查计划说跳过时绝不能再碰 autoUpdater——那正是「Can not find Squirrel」的来源。
    expect(source.indexOf("autoUpdater.checkForUpdates()")).toBeGreaterThan(
      source.indexOf('if (plan.kind === "SKIP")'),
    );
  });
});
