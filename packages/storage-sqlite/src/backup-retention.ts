import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 备份保留策略。
 *
 * 以前每个活动项目常年压着 12 份备份：每日 7 + 每周 4 + 手动 1，
 * 手动与 PRE_* 备份根本没有上限，升级前备份连目录表都不进、永远不删。
 * 实测本机 224 份登记备份 1.2 GB，外加 33 份升级前备份 154 MB。
 * 备份的用处是「昨天还好好的，今天坏了」，留两份即可覆盖。
 */
export const BACKUP_RETENTION_DEFAULTS = { dailyKeep: 2, weeklyKeep: 2, otherKeep: 2 };

/** 升级前备份不进目录表，按文件名保留最新的两份。 */
export const MIGRATION_BACKUPS_KEPT = 2;

const MIGRATION_BACKUP = /^pre-migration-v\d+-.*\.sqlite$/u;

export type BackupPolicy = {
  dailyKeep?: unknown;
  weeklyKeep?: unknown;
  otherKeep?: unknown;
};

function bounded(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(parsed)));
}

/** 每种备份原因各自的保留份数；DAILY/WEEKLY 以外的（手动、PRE_*、导出）走 otherKeep。 */
export function backupKeepCount(policy: BackupPolicy | null | undefined, reason: string): number {
  if (reason === "DAILY")
    return bounded(policy?.dailyKeep, BACKUP_RETENTION_DEFAULTS.dailyKeep, 90);
  if (reason === "WEEKLY")
    return bounded(policy?.weeklyKeep, BACKUP_RETENTION_DEFAULTS.weeklyKeep, 52);
  return bounded(policy?.otherKeep, BACKUP_RETENTION_DEFAULTS.otherKeep, 20);
}

/**
 * 清理目录里多余的升级前备份，返回删除数量。
 *
 * 迁移时写入的 `pre-migration-v<版本>-<时间戳>.sqlite` 不登记进 backup_catalog，
 * 目录表驱动的保留策略碰不到它们，所以升级一次留一份、一直堆着。
 */
export function pruneMigrationBackupFiles(
  directory: string,
  keep = MIGRATION_BACKUPS_KEPT,
): number {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return 0;
  }
  const files = entries
    .filter((name) => MIGRATION_BACKUP.test(name))
    .map((name) => {
      const path = join(directory, name);
      let modified = 0;
      try {
        modified = statSync(path).mtimeMs;
      } catch {
        return null;
      }
      return { path, name, modified };
    })
    .filter((file): file is { path: string; name: string; modified: number } => file !== null)
    // 按写入时间排序：文件名以版本号开头，而版本号小的可能反而是最新写下的那一份
    // （没有任何已应用迁移时前缀是 v0），只按文件名排会把刚写下的备份当成最旧的删掉。
    .sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name));
  let removed = 0;
  for (const file of files.slice(Math.max(1, keep))) {
    try {
      rmSync(file.path, { force: true });
      rmSync(`${file.path}-wal`, { force: true });
      rmSync(`${file.path}-shm`, { force: true });
      removed += 1;
    } catch {
      // 清不掉就留着：升级前备份是额外的保险，删不掉不能影响迁移或维护本身。
    }
  }
  return removed;
}
