/** Shared backup catalogue and maintenance contracts, independent of the coordinator. */
export type BackupView = {
  id: string;
  scope: "REGISTRY" | "PROJECT" | "KNOWLEDGE";
  projectId: string | null;
  projectCode: string | null;
  path: string;
  sha256: string;
  sizeBytes: number;
  reason: string;
  schemaVersion: number;
  createdAt: string;
  verifiedAt: string | null;
};

export type BackupProject = {
  id: string;
  code: string;
  name: string;
  description: string;
  databasePath: string;
  lifecycle: string;
  coordinationMode: string;
  sourcePaths: string[];
  version: number;
};

export type CreateBackupInput = {
  scope: "REGISTRY" | "PROJECT" | "KNOWLEDGE";
  project?: string;
  reason:
    | "MANUAL"
    | "DAILY"
    | "WEEKLY"
    | "PRE_MIGRATION"
    | "PRE_ARCHIVE"
    | "PRE_TRASH"
    | "PRE_RESTORE"
    | "EXPORT";
  createdAt?: string;
};

export type MaintenanceResult = {
  skipped: boolean;
  dailyCreated: number;
  weeklyCreated: number;
  /** 内容与上一份完全一致、直接沿用旧文件的次数。 */
  reusedBackups: number;
  /** 本次维护按保留策略删掉的备份份数，含不进目录表的升级前备份。 */
  prunedBackups: number;
  recoveredProjects: number;
  errors: Array<{ scope: string; project: string | null; message: string }>;
};
