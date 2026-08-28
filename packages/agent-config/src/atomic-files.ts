import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const BACKUP_RETENTION = 5;

export function backupName(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return `${path}.bak-${stamp}-${randomBytes(3).toString("hex")}`;
}

/** 保留受管文件最近的备份，其他文件一律不碰。 */
function pruneBackups(path: string, keep = BACKUP_RETENTION): string[] {
  const directory = dirname(path);
  const prefix = `${basename(path)}.bak-`;
  const stale = readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse()
    .slice(keep);
  for (const name of stale) rmSync(join(directory, name), { force: true });
  return stale;
}

/**
 * 用同目录临时文件 + rename 完成原子替换；已有文件先改名为备份。
 * 新文件已经落位后才清理旧备份，清理失败不会把成功写入报告为失败。
 */
export function replaceFileWithBackup(path: string, content: string): string | null {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (!existsSync(path)) {
    renameSync(temporary, path);
    return null;
  }

  const backupPath = backupName(path);
  renameSync(path, backupPath);
  try {
    renameSync(temporary, path);
  } catch (error) {
    if (!existsSync(path) && existsSync(backupPath)) renameSync(backupPath, path);
    throw error;
  }

  try {
    pruneBackups(path);
  } catch {
    // 备份清理是卫生问题，不是写入正确性问题。
  }
  return backupPath;
}
