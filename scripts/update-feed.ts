import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pruneUpdateFeed, scanUpdateFeed } from "../apps/desktop/src/update-coordinator.js";

export { updateFeedDir } from "../apps/desktop/src/updater.js";

/**
 * 把一个版本投递进本地更新源：先 zip，最后清单。core 只认「清单在」的版本
 * （update-coordinator.ts），所以清单写下去之前，半个 zip 不会被当成可安装的更新。
 *
 * 同版本重投递时旧清单还在：先删掉它，否则新 zip 写到一半的那段时间里，旧清单配着半个
 * 新 zip 就成了「就绪」。两个文件都先写 `.partial` 再改名，扫描只认最终名字。
 */
export function deliverUpdate(
  feed: string,
  packageDir: string,
  version: string,
): { zip: string; manifest: string } {
  mkdirSync(feed, { recursive: true });
  const zipName = `atm-${version}-win-x64.zip`;
  const manifestName = `atm-${version}-win-x64.json`;
  rmSync(join(feed, manifestName), { force: true });
  for (const name of [zipName, manifestName]) {
    const partial = join(feed, `${name}.partial`);
    copyFileSync(join(packageDir, name), partial);
    renameSync(partial, join(feed, name));
  }
  return { zip: join(feed, zipName), manifest: join(feed, manifestName) };
}

/**
 * 装好 `installedVersion` 之后清掉已消费的投递：不高于它的原生包与清单，以及 Squirrel
 * 时代留下的 RELEASES / *.nupkg。判据和运行中的 core 是同一份（scanUpdateFeed），
 * 两边对「什么算用完了」不会各说各的。
 */
export function pruneConsumedFeed(feed: string, installedVersion: string): string[] {
  return pruneUpdateFeed(feed, scanUpdateFeed(feed, installedVersion).consumed);
}
