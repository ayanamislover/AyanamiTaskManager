import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AtmError } from "@ayanami-task/errors";
import { createUlid, nowIso } from "@ayanami-task/protocol";
import { openManagedDatabase, quickCheck, type ManagedDatabase } from "./database.js";
import type { KnowledgeDatabase } from "./knowledge-database.js";
import {
  markProjectionDeferred,
  projectionErrorMessage,
  type ProjectionDispatchResult,
} from "./registry-projection-dispatcher.js";
import { discardDirectory, renameWithRetry, sha256File } from "./storage-file-operations.js";
import { backupArtifactProblem, backupFromRow } from "./backup-catalog.js";
import type { BackupProject, BackupView, CreateBackupInput } from "./backup-contracts.js";

const BACKUP_ARTIFACT_MESSAGES = {
  BACKUP_FILE_MISSING: "备份文件不存在",
  BACKUP_HASH_MISMATCH: "备份文件哈希不匹配",
  BACKUP_MANIFEST_MISSING: "备份清单不存在",
  BACKUP_MANIFEST_MISMATCH: "备份清单不匹配",
} as const;

/** 恢复一份备份需要的协作方；由 BackupMaintenance 注入，语义与它自己的私有成员一致。 */
export type BackupRestoreContext = {
  dataDir: string;
  migrationsRoot: string;
  registry: ManagedDatabase;
  knowledge: KnowledgeDatabase;
  getProject: (codeOrId: string) => BackupProject;
  closeProject: (projectId: string) => void;
  createBackup: (input: CreateBackupInput) => Promise<BackupView>;
  dispatchProject: (projectId: string) => Promise<ProjectionDispatchResult>;
  appendGlobalEvent: (type: string, aggregateId: string, actor: string, payload: unknown) => number;
};

/**
 * 恢复是一次独立的、带回滚的写操作，和日常的建备份/修剪/维护不在同一条路径上，
 * 所以单独成模块：备份维护那边只留下入口，恢复的原子性知识集中在这里。
 */
export async function restoreBackupWithContext(
  context: BackupRestoreContext,
  backupId: string,
): Promise<{ backup: BackupView; project: BackupProject | null }> {
  const row = context.registry.sqlite
    .prepare(
      `SELECT backup_catalog.*, projects.code AS project_code
       FROM backup_catalog LEFT JOIN projects ON projects.id = backup_catalog.project_id
       WHERE backup_catalog.id = ?`,
    )
    .get(backupId) as any;
  if (!row) {
    throw new AtmError("BACKUP_NOT_FOUND", {
      message: `备份不存在：${backupId}`,
      details: { reference: backupId },
    });
  }
  const backup = backupFromRow(row);
  if ((backup.scope !== "PROJECT" || !backup.projectId) && backup.scope !== "KNOWLEDGE") {
    throw new AtmError("BACKUP_RESTORE_SCOPE_UNSUPPORTED", {
      message: "该备份范围不支持恢复",
    });
  }
  const problem = backupArtifactProblem(backup);
  if (problem) throw new AtmError(problem, { message: BACKUP_ARTIFACT_MESSAGES[problem] });

  if (backup.scope === "KNOWLEDGE") {
    // 先把选中的快照复制成独立候选再动别的：接下来新建的 PRE_RESTORE 会触发同类修剪，
    // 而被挤掉的最旧一份可能正是用户选中要恢复的这一份（PRE_RESTORE 有上限之后才出现）。
    // 项目分支本来就是先复制候选再建 PRE_RESTORE，这里对齐同样的顺序。
    // 上一次留下的同名暂存删不掉（句柄还被占着）时换一个目录，不要卡在这里。
    const preferred = join(context.dataDir, "knowledge", `.restore-${backup.id}`);
    const stagingDirectory = discardDirectory(preferred)
      ? preferred
      : `${preferred}-${createUlid()}`;
    const candidatePath = join(stagingDirectory, "knowledge.sqlite");
    mkdirSync(stagingDirectory, { recursive: true });
    try {
      copyFileSync(backup.path, candidatePath);
      if (sha256File(candidatePath) !== backup.sha256) {
        throw new AtmError("BACKUP_HASH_MISMATCH", { message: "备份文件哈希不匹配" });
      }
      try {
        await context.createBackup({ scope: "KNOWLEDGE", reason: "PRE_RESTORE" });
      } catch (error) {
        // Corrupt sources cannot produce a SQLite backup. restoreFrom retains their
        // exact original file as a recovery artifact instead of destroying it.
        if (!(error instanceof AtmError) || error.code !== "KNOWLEDGE_UNAVAILABLE") throw error;
      }
      await context.knowledge.restoreFrom(candidatePath);
    } finally {
      // 数据已经恢复完成，收尾删不掉暂存目录也不能把这次恢复报成失败。
      discardDirectory(stagingDirectory);
    }
    try {
      context.appendGlobalEvent("backup.restored", backup.id, "USER", { scope: "KNOWLEDGE" });
    } catch {
      /* The knowledge commit is durable even when the Registry event is unavailable. */
    }
    return { backup, project: null };
  }
  const project = context.getProject(backup.projectId!);
  const restoreDirectory = join(context.dataDir, "projects", `.restore-${backup.id}`);
  const candidatePath = join(restoreDirectory, "project.sqlite");
  const rollbackPath = `${project.databasePath}.restore-old-${backup.id}`;
  rmSync(restoreDirectory, { recursive: true, force: true });
  mkdirSync(join(restoreDirectory, "backups"), { recursive: true });
  copyFileSync(backup.path, candidatePath);
  let candidate: ManagedDatabase | null = null;
  let currentRenamed = false;
  let restoreCommitted = false;
  try {
    candidate = await openManagedDatabase({
      path: candidatePath,
      migrationDirectory: join(context.migrationsRoot, "project"),
      backupDirectory: join(restoreDirectory, "backups"),
    });
    const identity = candidate.sqlite
      .prepare("SELECT project_id, project_code FROM project_meta WHERE singleton = 1")
      .get() as { project_id: string; project_code: string } | undefined;
    if (!identity || identity.project_id !== project.id || identity.project_code !== project.code) {
      throw new AtmError("BACKUP_PROJECT_IDENTITY_MISMATCH", {
        message: "备份项目身份不匹配",
      });
    }
    if (!quickCheck(candidate.sqlite)) {
      throw new AtmError("BACKUP_INTEGRITY_FAILED", { message: "备份完整性检查失败" });
    }
    candidate.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    candidate.sqlite.close();
    candidate = null;

    await context.createBackup({ scope: "PROJECT", project: project.id, reason: "PRE_RESTORE" });
    context.registry.sqlite
      .prepare("UPDATE projects SET lifecycle = 'RESTORING', updated_at = ? WHERE id = ?")
      .run(nowIso(), project.id);
    context.closeProject(project.id);

    rmSync(rollbackPath, { force: true });
    for (const suffix of ["-wal", "-shm"]) {
      rmSync(`${project.databasePath}${suffix}`, { force: true });
    }
    await renameWithRetry(project.databasePath, rollbackPath);
    currentRenamed = true;
    await renameWithRetry(candidatePath, project.databasePath);
    context.registry.sqlite.transaction(() => {
      context.registry.sqlite
        .prepare(
          "UPDATE projects SET lifecycle = 'ACTIVE', version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(nowIso(), project.id);
      context.appendGlobalEvent("backup.restored", backup.id, "USER", {
        projectId: project.id,
        projectCode: project.code,
      });
    })();
    restoreCommitted = true;

    try {
      await context.dispatchProject(project.id);
    } catch (error) {
      markProjectionDeferred(context.registry, project.id, projectionErrorMessage(error));
    }
    try {
      rmSync(rollbackPath, { force: true });
    } catch {
      // Registry ACTIVE is already committed; startup recovery safely removes this rollback.
    }
    return { backup, project: context.getProject(project.id) };
  } catch (error) {
    if (!restoreCommitted) {
      context.closeProject(project.id);
      if (currentRenamed && existsSync(rollbackPath)) {
        rmSync(project.databasePath, { force: true });
        await renameWithRetry(rollbackPath, project.databasePath);
      }
      context.registry.sqlite
        .prepare("UPDATE projects SET lifecycle = 'ACTIVE', updated_at = ? WHERE id = ?")
        .run(nowIso(), project.id);
    }
    throw error;
  } finally {
    if (candidate?.sqlite.open) candidate.sqlite.close();
    try {
      rmSync(restoreDirectory, { recursive: true, force: true });
    } catch {
      // Startup recovery removes stale restore candidates without changing a committed result.
    }
  }
}
