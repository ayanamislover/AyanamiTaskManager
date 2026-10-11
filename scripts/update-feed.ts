import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * 本地更新源：3.0 根下的 `updates\`（`N\updates`）。读它的是宿主里的更新协调
 * （jobs/src/update.rs：`data_dir.join("updates")`，宿主传的 data_dir 是 N）；脚本这边只有这里
 * 知道目录名，有用例把两边钉在一起。
 */
export function updateFeedDir(v3Root: string): string {
  return join(v3Root, "updates");
}

/**
 * 把一个版本投递进本地更新源：先 zip，最后清单。宿主只认「清单在」的版本
 * （jobs/src/update.rs `scan_feed`），所以清单写下去之前，半个 zip 不会被当成可安装的更新。
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

/** `<主>.<次>.<修订>`（每段 1～9 位数字），可带 `-<预发布>`：与 jobs/src/update.rs `version_valid` 同一规则。 */
function versionValid(version: string): boolean {
  const dash = version.indexOf("-");
  const core = dash < 0 ? version : version.slice(0, dash);
  const pre = dash < 0 ? null : version.slice(dash + 1);
  return (
    /^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(core) && (pre === null || /^[A-Za-z0-9.]{1,32}$/u.test(pre))
  );
}

/** 逐段比数字（段里数字之后的部分不算），缺的段按 0：与 `compare_versions` 同一规则。 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value.split(".").map((part) => Number(/^\d*/u.exec(part)![0] || "0"));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** Squirrel 时代投递的 RELEASES 与 nupkg：与 `squirrel_name` 同一规则。 */
function squirrelName(name: string): boolean {
  return name === "RELEASES" || /^[A-Za-z0-9][A-Za-z0-9._+-]*\.nupkg$/u.test(name);
}

/**
 * 装好 `installedVersion` 之后可以清掉的投递：不高于它的原生包与清单，以及 Squirrel 时代
 * 留下的 RELEASES / *.nupkg。判据与宿主的 `scan_feed` 的 consumed 是同一份（只看单层普通文件，
 * 名字不合模式的一律不碰），两边对「什么算用完了」不会各说各的。
 */
export function consumedFeedFiles(feed: string, installedVersion: string): string[] {
  let entries;
  try {
    entries = readdirSync(feed, { withFileTypes: true });
  } catch {
    return [];
  }
  const consumed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (squirrelName(name)) {
      consumed.push(name);
      continue;
    }
    const version = /^atm-(.+)-win-x64\.(?:json|zip)$/u.exec(name)?.[1];
    if (version === undefined || !versionValid(version)) continue;
    if (compareVersions(version, installedVersion) <= 0) consumed.push(name);
  }
  return consumed.sort();
}

/** 删掉已消费的投递，返回删掉的名字；删不掉就留着，清理失败不算安装失败。 */
export function pruneConsumedFeed(feed: string, installedVersion: string): string[] {
  return consumedFeedFiles(feed, installedVersion).filter((name) => {
    if (basename(name) !== name) return false;
    try {
      rmSync(join(feed, name));
      return true;
    } catch {
      return false;
    }
  });
}
