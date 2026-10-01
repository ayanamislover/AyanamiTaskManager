import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pruneUpdateFeed, scanUpdateFeed } from "../apps/desktop/src/update-coordinator.js";

export { updateFeedDir } from "../apps/desktop/src/updater.js";

/**
 * 把一个版本投递进本地更新源：先 zip，最后清单。core 只认「清单在」的版本
 * （update-coordinator.ts），所以清单写下去之前，半个 zip 不会被当成可安装的更新。
 */
export function deliverUpdate(
  feed: string,
  packageDir: string,
  version: string,
): { zip: string; manifest: string } {
  mkdirSync(feed, { recursive: true });
  const zipName = `atm-${version}-win-x64.zip`;
  const manifestName = `atm-${version}-win-x64.json`;
  copyFileSync(join(packageDir, zipName), join(feed, zipName));
  copyFileSync(join(packageDir, manifestName), join(feed, manifestName));
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
