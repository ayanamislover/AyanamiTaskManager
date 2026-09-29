import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";

// 进度条的「已完成」只认 completed_at。早年直接登记为已完成的任务没有 completed_at，
// 完成时间未知；它的 updated_at 会随改标题等普通编辑变化，不能拿来顶替，
// 否则重启后改个标题，旧任务就被当成「本次完成」。

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-progress-strip-"));
  temporary.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: "进度条", sourcePath: null, code: "PST" });
  const database = await manager.openProject(project.id);
  const repository = new ProjectRepository(database);
  const session = repository.createSession({
    agentId: "strip-agent",
    displayName: "Strip Agent",
    clientKind: "test",
    role: "SUBAGENT",
  });
  const actor = { type: "AGENT" as const, id: "strip-agent", sessionId: session.id };
  const objective = repository.createObjective(actor, {
    title: "分组",
    description: "",
    definitionOfDone: [],
  });
  return { database, repository, actor, objective };
}

describe("进度条已完成段的完成时间", () => {
  it("直接登记为已完成时写入完成时间；缺完成时间的历史任务编辑后也不算本次", async () => {
    const { database, repository, actor, objective } = await fixture();
    const [recorded, legacy] = repository.createWorkItems(actor, "create-done", [
      {
        clientRef: "recorded",
        objectiveId: objective.id,
        title: "补登",
        type: "TASK" as const,
        priority: "NORMAL" as const,
        status: "DONE" as const,
      },
      {
        clientRef: "legacy",
        objectiveId: objective.id,
        title: "历史补登",
        type: "TASK" as const,
        priority: "NORMAL" as const,
        status: "DONE" as const,
      },
    ]).items;
    const completedAt = (key: string) =>
      (
        database.sqlite
          .prepare("SELECT completed_at FROM work_items WHERE local_no = ?")
          .get(Number(key.split("-").at(-1))) as { completed_at: string | null }
      ).completed_at;
    expect(completedAt(recorded!.key)).not.toBeNull();

    // 模拟修复前留下的历史行：已完成，但没有完成时间，最后更新时间还很早。
    database.sqlite
      .prepare(
        "UPDATE work_items SET completed_at = NULL, updated_at = '2001-01-01T00:00:00.000Z' WHERE local_no = ?",
      )
      .run(Number(legacy!.key.split("-").at(-1)));

    const since = new Date(Date.now() + 1).toISOString();
    await new Promise((done) => setTimeout(done, 5));
    expect(repository.progressStrip(since).done).toBe(0);

    repository.patchWorkItems(actor, "rename-legacy", [
      {
        taskKey: legacy!.key,
        expectedVersion: legacy!.version,
        operation: "edit",
        title: "历史补登（改名）",
      },
    ]);
    // 改名刷新了 updated_at，但没有发生新的完成。
    expect(repository.progressStrip(since).done).toBe(0);
    expect(repository.progressStrip("2000-01-01T00:00:00.000Z").done).toBe(1);
  });
});
