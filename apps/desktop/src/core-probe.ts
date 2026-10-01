import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { probeAppliedMigrations } from "@ayanami-task/storage-sqlite";
import type { ProbeDatabase } from "./host-protocol.js";

/** 与 native/install-state 的常量一一对应；两边读同一份文件。 */
const STATE_DIR = "state";
const JOURNAL = "install.json";
const LOCK = "install.lock";
const MAX_STATE_BYTES = 256 * 1024;

/**
 * 只有持锁的 setup 在 PROBE 这一步、并且目标就是本版本时，探测才成立（de-electron §3.0）。
 * 宿主已经判过一次；core 不信握手自报，按自己的 bundle 位置再读一遍同一份日志。
 */
export function probeTransactionBound(appDir: string, txn: string): boolean {
  const version = /^app-(.+)$/u.exec(basename(appDir))?.[1];
  if (!version) return false;
  const state = join(dirname(appDir), STATE_DIR);
  try {
    const journalPath = join(state, JOURNAL);
    if (statSync(journalPath).size > MAX_STATE_BYTES) return false;
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    if (journal.id !== txn || journal.state !== "PROBE" || journal.to !== version) return false;
  } catch {
    return false;
  }
  return installLockHeld(join(state, LOCK));
}

/**
 * setup 以独占方式（share mode 0）打开锁文件；别人能打开就说明没人持锁。
 * 打开成功时立刻关掉，不留任何句柄。
 */
function installLockHeld(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  try {
    closeSync(openSync(lockPath, "r"));
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EBUSY";
  }
}

export type ProbeOutcome =
  | { ok: true; databases: ProbeDatabase[] }
  | { ok: false; code: string; scope: string | null };

/** 数据根里所有受迁移管理的库：registry、knowledge、每个项目库。不存在的跳过（首装）。 */
function databases(dataDir: string): Array<{ scope: ProbeDatabase["scope"]; path: string }> {
  const found: Array<{ scope: ProbeDatabase["scope"]; path: string }> = [];
  const registry = join(dataDir, "registry", "registry.sqlite");
  if (existsSync(registry)) found.push({ scope: "registry", path: registry });
  const knowledge = join(dataDir, "knowledge", "knowledge.sqlite");
  if (existsSync(knowledge)) found.push({ scope: "knowledge", path: knowledge });
  const projects = join(dataDir, "projects");
  if (existsSync(projects))
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      // .creating-* / .restore-* 是进行中的事务目录，由正式启动的恢复逻辑处理。
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(projects, entry.name, "project.sqlite");
      if (existsSync(path)) found.push({ scope: "project", path });
    }
  return found;
}

/** 新版本能不能读这份数据：每个库已应用的迁移都必须在本版随包集合里。 */
export function probeDataRoot(dataDir: string, migrationsRoot: string): ProbeOutcome {
  const checked: ProbeDatabase[] = [];
  for (const database of databases(dataDir)) {
    try {
      const result = probeAppliedMigrations(database.path, join(migrationsRoot, database.scope));
      checked.push({ scope: database.scope, ...result });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return {
        ok: false,
        code: typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : "PROBE_FAILED",
        scope: database.scope,
      };
    }
  }
  return { ok: true, databases: checked };
}
