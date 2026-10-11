import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  consumedFeedFiles,
  deliverUpdate,
  pruneConsumedFeed,
  updateFeedDir,
} from "../../../scripts/update-feed.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "atm-feed-"));
  temporary.push(directory);
  return directory;
}

/** 一个打包目录：zip 与清单（清单内容由 core 校验，这里只关心投递与清理）。 */
function packageDir(version: string): string {
  const directory = scratch();
  writeFileSync(join(directory, `atm-${version}-win-x64.zip`), `zip ${version}`, "utf8");
  writeFileSync(join(directory, `atm-${version}-win-x64.json`), `{"version":"${version}"}`, "utf8");
  return directory;
}

describe("本地更新源", () => {
  it("投递 zip 与清单，清单在 zip 之后写", () => {
    const feed = join(scratch(), "feed");
    const delivered = deliverUpdate(feed, packageDir("9.0.1"), "9.0.1");
    expect(readdirSync(feed).sort()).toEqual(["atm-9.0.1-win-x64.json", "atm-9.0.1-win-x64.zip"]);
    expect(readFileSync(delivered.zip, "utf8")).toBe("zip 9.0.1");
  });

  // 同版本重投递：旧清单先撤，新 zip 写完前扫描看不到「就绪」；不留 .partial。
  it("同版本重投递先撤旧清单、经临时名改名，不留半成品", () => {
    const feed = join(scratch(), "feed");
    deliverUpdate(feed, packageDir("9.0.1"), "9.0.1");
    const rebuilt = packageDir("9.0.1");
    writeFileSync(join(rebuilt, "atm-9.0.1-win-x64.zip"), "zip 9.0.1 rebuilt", "utf8");
    const delivered = deliverUpdate(feed, rebuilt, "9.0.1");
    expect(readFileSync(delivered.zip, "utf8")).toBe("zip 9.0.1 rebuilt");
    expect(readdirSync(feed).sort()).toEqual(["atm-9.0.1-win-x64.json", "atm-9.0.1-win-x64.zip"]);
    const source = readFileSync(join(process.cwd(), "scripts", "update-feed.ts"), "utf8");
    expect(source.indexOf("rmSync(join(feed, manifestName)")).toBeLessThan(
      source.indexOf("copyFileSync(join(packageDir, name), partial)"),
    );
    expect(source.indexOf("rmSync(join(feed, manifestName)")).toBeGreaterThan(0);
  });

  // 投递是一次性的，装完没人负责收。清理的判据必须和宿主的 scan_feed 是同一份，
  // 否则一边把包当「还没装」提示更新，另一边已经把它删了。
  it("装好之后只清已消费的：不高于已装版本的包与 Squirrel 遗留，更新的与无关文件都留下", () => {
    const feed = join(scratch(), "feed");
    mkdirSync(feed, { recursive: true });
    deliverUpdate(feed, packageDir("9.0.0"), "9.0.0");
    deliverUpdate(feed, packageDir("9.0.1"), "9.0.1");
    deliverUpdate(feed, packageDir("9.0.2"), "9.0.2");
    writeFileSync(join(feed, "RELEASES"), "AAA AyanamiTaskManagerDesktop-1.2.2-full.nupkg 1\n");
    writeFileSync(join(feed, "AyanamiTaskManagerDesktop-1.2.2-full.nupkg"), "old");
    writeFileSync(join(feed, "notes.txt"), "keep me");

    const removed = pruneConsumedFeed(feed, "9.0.1");
    expect(removed.sort()).toEqual(
      [
        "AyanamiTaskManagerDesktop-1.2.2-full.nupkg",
        "RELEASES",
        "atm-9.0.0-win-x64.json",
        "atm-9.0.0-win-x64.zip",
        "atm-9.0.1-win-x64.json",
        "atm-9.0.1-win-x64.zip",
      ].sort(),
    );
    expect(readdirSync(feed).sort()).toEqual([
      "atm-9.0.2-win-x64.json",
      "atm-9.0.2-win-x64.zip",
      "notes.txt",
    ]);
    // 剩下的正是宿主会当成待装候选的那个版本，再扫一遍没有可清的。
    expect(consumedFeedFiles(feed, "9.0.1")).toEqual([]);
    // 幂等。
    expect(pruneConsumedFeed(feed, "9.0.1")).toEqual([]);
  });

  // 名字不合模式的不碰：与宿主的 version_valid / squirrel_name 同一规则。
  it("只清合模式的名字：坏版本号、多一层后缀、目录都留下", () => {
    const feed = join(scratch(), "feed");
    mkdirSync(join(feed, "atm-1.0.0-win-x64.zip"), { recursive: true });
    for (const name of [
      "atm-1.0-win-x64.json",
      "atm-1.0.0.0-win-x64.zip",
      "atm-1.0.0-win-x64.json.partial",
      "atm-01234567890.0.0-win-x64.json",
      "-bad.nupkg",
      "atm-1.0.0-rc.1-win-x64.json",
    ])
      writeFileSync(join(feed, name), "x");
    expect(consumedFeedFiles(feed, "2.0.0")).toEqual(["atm-1.0.0-rc.1-win-x64.json"]);
    expect(compareVersions("1.1.0", "1.0.27")).toBe(1);
    // 与 compare_versions 一样只按「.」切段：「0-rc」取 0，其后的「1」算第四段。
    expect(compareVersions("3.0.0-rc.1", "3.0.0")).toBe(1);
    expect(compareVersions("3.0.0-rc", "3.0.0")).toBe(0);
    expect(compareVersions("3.0", "3.0.0")).toBe(0);
  });

  // 「feed 在哪」和「快捷方式在哪」是同一类问题：两处各存一份认知，迟早一处投递、另一处清理，
  // 对不上。读 feed 的是宿主（jobs/src/update.rs，data_dir 由宿主传 N）；脚本这边只有
  // update-feed.ts 知道目录名。
  it("只有 update-feed.ts 知道 feed 的目录名，且与宿主读的是同一处（N 下的 updates）", () => {
    const sources = [
      "scripts/release-and-install.ts",
      "scripts/distribution-smoke.ts",
      "scripts/distribution-common.ts",
      "scripts/distribution-installed.ts",
    ];
    for (const source of sources) {
      const content = readFileSync(join(process.cwd(), source), "utf8");
      expect({ source, hardcoded: content.includes(`"updates"`) }).toEqual({
        source,
        hardcoded: false,
      });
    }
    const native = (path: string) =>
      readFileSync(join(process.cwd(), "apps/desktop/native", path), "utf8");
    expect(readFileSync(join(process.cwd(), "scripts/update-feed.ts"), "utf8")).toContain(
      `return join(v3Root, "updates");`,
    );
    expect(native("jobs/src/update.rs")).toContain(`feed: o.data_dir.join("updates"),`);
    expect(native("host/src/app.rs")).toMatch(
      /Coordinator::new\(updates::Options \{\s*data_dir: self\.layout\.v3_root\.clone\(\),/u,
    );
    expect(updateFeedDir("C:\\N")).toBe("C:\\N\\updates");
    // 不再借 2.x Node 的更新协调。
    expect(readFileSync(join(process.cwd(), "scripts/update-feed.ts"), "utf8")).not.toMatch(
      /update-coordinator|updater\.js/u,
    );
  });
});
