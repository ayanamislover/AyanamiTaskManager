import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/** 上一次运行留下的合成 home 要过多久才允许回收。 */
export const SMOKE_WORKSPACE_RETENTION_MS = 6 * 60 * 60 * 1000;

export type ReclaimSmokeWorkspacesOptions = {
  directory: string;
  prefix: string;
  /** 本次运行自己在用的目录，永远不动。 */
  keep?: readonly string[];
  retentionMs?: number;
  now?: number;
  /** 只为让用例能注入一个删不掉的目录；生产路径一律用默认的 rm。 */
  remove?: (path: string) => Promise<void>;
};

/**
 * 回收 smoke 留下的同前缀兄弟目录，返回真正删掉的那些。
 *
 * 这些目录当初改成每次新建一个 UUID 名，是因为 IME helper 会比 Electron 活得久、
 * 还攥着合成 USERPROFILE 下的日志句柄，删「上一次」必然失败。但那只能证明不能删最近
 * 的一个，不能证明一个都不能清——实测 output/ 下攒了 4 个，其中一个还是当初删不掉时
 * 手工改名隔离的残留。
 *
 * 攒着的直接后果不只是占盘：打包流程会去遍历它们，而合成 home 里有
 * INetCache\\Content.IE5 这类连属主都拒绝列目录的系统目录，扫到就是 EPERM。
 *
 * 所以逐个 try/catch：删不掉的跳过，不要因为一个被占用就一个都不删。
 */
export async function reclaimSmokeWorkspaces({
  directory,
  prefix,
  keep = [],
  retentionMs = SMOKE_WORKSPACE_RETENTION_MS,
  now = Date.now(),
  remove = (path) => rm(path, { recursive: true, force: true, maxRetries: 3 }),
}: ReclaimSmokeWorkspacesOptions): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const kept = new Set(keep.map((path) => resolve(path)));
  const reclaimed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const path = resolve(join(directory, entry.name));
    if (kept.has(path)) continue;
    try {
      // 目录 mtime 反映的是这一层最后一次增删子项的时刻，够用来分辨「上一次运行」。
      if (now - (await stat(path)).mtimeMs < retentionMs) continue;
      await remove(path);
      reclaimed.push(path);
    } catch {
      // 还被占着的旧 home 留给下一次；占用不能阻断本次 smoke，更不能连累别的目录。
    }
  }
  return reclaimed;
}
