import { existsSync, readFileSync } from "node:fs";
import { sha256File } from "./storage-file-operations.js";
import type { BackupView } from "./backup-contracts.js";

/** backup_catalog 的一行（可能带 join 出来的 project_code）转成对外视图。 */
export function backupFromRow(row: any): BackupView {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id,
    projectCode: row.project_code ?? null,
    path: row.path,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    reason: row.reason,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

export type BackupArtifactProblem =
  | "BACKUP_FILE_MISSING"
  | "BACKUP_HASH_MISMATCH"
  | "BACKUP_MANIFEST_MISSING"
  | "BACKUP_MANIFEST_MISMATCH";

/**
 * 一份登记过的备份在盘上是否还完好：文件在、内容哈希与目录表一致、清单在且对得上。
 *
 * 恢复和「内容没变就沿用旧备份」用的是同一套判据。分开写过一次的后果是去重那边
 * 只看了文件在不在：旧文件被截断或清单丢了照样复用，于是刚通过完整性检查的新快照
 * 被删掉，留下一份恢复时才会报 BACKUP_HASH_MISMATCH 的坏备份。
 */
export function backupArtifactProblem(backup: BackupView): BackupArtifactProblem | null {
  if (!existsSync(backup.path)) return "BACKUP_FILE_MISSING";
  if (sha256File(backup.path) !== backup.sha256) return "BACKUP_HASH_MISMATCH";
  const manifestPath = `${backup.path}.manifest.json`;
  if (!existsSync(manifestPath)) return "BACKUP_MANIFEST_MISSING";
  let manifest: { id?: string; projectId?: string | null; sha256?: string; scope?: string };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return "BACKUP_MANIFEST_MISMATCH";
  }
  if (
    manifest.id !== backup.id ||
    manifest.projectId !== backup.projectId ||
    manifest.sha256 !== backup.sha256 ||
    manifest.scope !== backup.scope
  ) {
    return "BACKUP_MANIFEST_MISMATCH";
  }
  return null;
}
