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
