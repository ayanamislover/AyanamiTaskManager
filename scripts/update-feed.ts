import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export { updateFeedDir } from "../apps/desktop/src/updater.js";

/** RELEASES 每行是 `<SHA1> <文件名> <字节数>`，只有第二列有用。 */
export function releasesPackages(releases: string): string[] {
  return releases
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u)[1])
    .filter((name): name is string => Boolean(name));
}

/**
 * Squirrel 产出的 RELEASES 每次只列当前这一个 full 包，旧包不会被任何人删掉——
 * 而 feed 是发布脚本写的，Squirrel 只读不管。发一版留一份 161.7 MB：跑到 1.0.9
 * 时 feed 已经 647 MB，其中 485 MB 是 RELEASES 根本没提到的死重。
 *
 * 判据只有一条：RELEASES 列了就留。没有 RELEASES 时一个都不删——那种状态下
 * 「谁还有用」无从判断，宁可留着。
 */
export function pruneUpdateFeed(feed: string): string[] {
  const releases = join(feed, "RELEASES");
  if (!existsSync(releases)) return [];
  const keep = new Set(releasesPackages(readFileSync(releases, "utf8")));
  const stale = readdirSync(feed).filter(
    (name) => name.toLowerCase().endsWith(".nupkg") && !keep.has(name),
  );
  for (const name of stale) rmSync(join(feed, name), { force: true });
  return stale;
}
