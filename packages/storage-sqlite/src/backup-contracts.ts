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
  recoveredProjects: number;
  errors: Array<{ scope: string; project: string | null; message: string }>;
};
