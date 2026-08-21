import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneUpdateFeed, releasesPackages } from "../../../scripts/update-feed.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function feedFixture(releases: string | null): string {
  const feed = mkdtempSync(join(tmpdir(), "atm-feed-"));
  temporary.push(feed);
  for (const version of ["1.0.6", "1.0.7", "1.0.8"]) {
    writeFileSync(join(feed, `AyanamiTaskManagerDesktop-${version}-full.nupkg`), version, "utf8");
  }
  // feed 里不只有包：RELEASES 之外的东西一概不该被碰。
  writeFileSync(join(feed, "notes.txt"), "keep me", "utf8");
  if (releases !== null) writeFileSync(join(feed, "RELEASES"), releases, "utf8");
  return feed;
}

describe("本地更新源", () => {
  it("RELEASES 每行取第二列，忽略空行", () => {
    expect(
      releasesPackages(
        "AAA AyanamiTaskManagerDesktop-1.0.8-full.nupkg 169596287\r\n\r\nBBB b.nupkg 1\n",
      ),
    ).toEqual(["AyanamiTaskManagerDesktop-1.0.8-full.nupkg", "b.nupkg"]);
  });

  // Squirrel 的 RELEASES 每次只列当前这一个 full 包，旧包不会被任何人删掉——
  // feed 是发布脚本写的，Squirrel 只读不管。跑到 1.0.9 时实测已经堆到 647 MB，
  // 其中 485 MB 是 RELEASES 根本没提到的死重。
  it("只删 RELEASES 没列出的包，列出的和非包文件都留下", () => {
    const feed = feedFixture("AAA AyanamiTaskManagerDesktop-1.0.8-full.nupkg 169596287\n");
    const removed = pruneUpdateFeed(feed);
    expect(removed.sort()).toEqual([
      "AyanamiTaskManagerDesktop-1.0.6-full.nupkg",
      "AyanamiTaskManagerDesktop-1.0.7-full.nupkg",
    ]);
    expect(readdirSync(feed).sort()).toEqual([
      "AyanamiTaskManagerDesktop-1.0.8-full.nupkg",
      "RELEASES",
      "notes.txt",
    ]);
    // 幂等：再跑一次没有可删的。
    expect(pruneUpdateFeed(feed)).toEqual([]);
  });

  // 没有 RELEASES 就无从判断谁还有用。这时删任何一个都可能删掉唯一可用的包，
  // 而多留几份只是占磁盘。
  it("没有 RELEASES 时一个都不删", () => {
    const feed = feedFixture(null);
    expect(pruneUpdateFeed(feed)).toEqual([]);
    expect(readdirSync(feed)).toHaveLength(4);
    expect(existsSync(join(feed, "AyanamiTaskManagerDesktop-1.0.6-full.nupkg"))).toBe(true);
  });

  // 「feed 在哪」和「快捷方式在哪」是同一类问题：两处各存一份认知，迟早一处
  // 投递、另一处清理，对不上。updater.ts 是应用读 feed 的地方，就以它为准。
  it("只有 updater.ts 知道 feed 的目录名", () => {
    const sources = [
      "scripts/release-and-install.ts",
      "scripts/update-feed.ts",
      "scripts/distribution-smoke.ts",
      "apps/desktop/src/main.ts",
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
