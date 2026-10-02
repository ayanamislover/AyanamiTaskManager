import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanUpdateFeed } from "../src/update-coordinator.js";
import { deliverUpdate, pruneConsumedFeed } from "../../../scripts/update-feed.js";

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

  // 投递是一次性的，装完没人负责收。清理的判据必须和运行中的 core 是同一份，
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
    // 与 core 同口径：剩下的正是 core 会当成待装候选的那个版本。
    expect(scanUpdateFeed(feed, "9.0.1").consumed).toEqual([]);
    // 幂等。
    expect(pruneConsumedFeed(feed, "9.0.1")).toEqual([]);
  });

  // 「feed 在哪」和「快捷方式在哪」是同一类问题：两处各存一份认知，迟早一处
  // 投递、另一处清理，对不上。updater.ts 是应用读 feed 的地方，就以它为准。
  it("只有 updater.ts 知道 feed 的目录名", () => {
    const sources = [
      "scripts/release-and-install.ts",
      "scripts/update-feed.ts",
      "scripts/distribution-smoke.ts",
      "apps/desktop/src/core-main.ts",
      "apps/desktop/src/update-coordinator.ts",
    ];
    for (const source of sources) {
      const content = readFileSync(join(process.cwd(), source), "utf8");
      expect({ source, hardcoded: content.includes(`"updates"`) }).toEqual({
        source,
        hardcoded: false,
      });
    }
    // 阳性对照：扫描面本身是活的——updater.ts 里确实有这个字面量。
    expect(readFileSync(join(process.cwd(), "apps/desktop/src/updater.ts"), "utf8")).toContain(
      `"updates"`,
    );
  });
});
