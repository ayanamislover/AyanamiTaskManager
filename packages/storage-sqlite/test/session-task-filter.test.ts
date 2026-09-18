import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/manager.js";
import { ProjectRepository } from "../src/project-repository.js";

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function fixture(code: string) {
  const root = mkdtempSync(join(tmpdir(), `atm-session-task-filter-${code.toLowerCase()}-`));
  temporary.push(root);
  const manager = await AyanamiDatabaseManager.open({
    dataDir: join(root, "data"),
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: code, sourcePath: null, code });
  const database = await manager.openProject(project.code);
  const repository = new ProjectRepository(database);
  const session = repository.createSession({
    agentId: "filter-owner",
    displayName: "Owner",
    clientKind: "test",
    role: "PRIMARY",
  });
  const actor = { type: "AGENT" as const, id: "filter-owner", sessionId: session.id };
  return { database, repository, actor };
}

/**
 * 任务抽屉只要某一个任务的 Session。
 *
 * 以前是把整个项目的 Session 分页全拉回前端再按 currentTaskKey 筛：ATM 自己有 335 条，
 * 每页 100 就是四个来回，只为找出其中几条，而且页数越多抽屉开得越慢。
 */
describe("Session 分页按任务过滤", () => {
  it("只返回领了这个任务的 Session，认不出来的任务键返回空而不是全部", async () => {
    const { database, repository, actor } = await fixture("SFT");
    const objective = repository.createObjective(actor, {
      title: "目标",
      description: "",
      definitionOfDone: [],
    });
    const created = repository.createWorkItems(actor, "seed", [
      {
        clientRef: "a",
        objectiveId: objective.id,
        title: "任务甲",
        description: "",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
        acceptance: [],
        checklist: [],
        verificationRequired: false,
      },
      {
        clientRef: "b",
        objectiveId: objective.id,
        title: "任务乙",
        description: "",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
        acceptance: [],
        checklist: [],
        verificationRequired: false,
      },
    ]);
    const [first, second] = created.items;

    const sessions = ["甲-1", "甲-2", "乙-1", "无任务"].map((name, index) =>
      repository.createSession({
        agentId: `agent-${index}`,
        displayName: name,
        clientKind: "test",
        role: "SUBAGENT",
      }),
    );
    const assign = database.sqlite.prepare(
      "UPDATE agent_sessions SET current_work_item_id = ? WHERE id = ?",
    );
    assign.run(first!.id, sessions[0]!.id);
    assign.run(first!.id, sessions[1]!.id);
    assign.run(second!.id, sessions[2]!.id);

    const forFirst = repository.listAgentSessionPage({ taskKey: first!.key });
    expect(forFirst.items.map((item) => item.displayName).sort()).toEqual(["甲-1", "甲-2"]);
    expect(forFirst.hasMore).toBe(false);

    expect(
      repository
        .listAgentSessionPage({ taskKey: second!.key })
        .items.map((item) => item.displayName),
    ).toEqual(["乙-1"]);

    // 认不出来的键是「没有任何 Session」，绝不能退化成不过滤。
    expect(repository.listAgentSessionPage({ taskKey: "SFT-T-9999" }).items).toEqual([]);
    expect(repository.listAgentSessionPage({ taskKey: "乱写的" }).items).toEqual([]);

    // 不传 taskKey 仍然是全部：四条测试 Session 加上夹具自己那条。
    expect(repository.listAgentSessionPage().items).toHaveLength(5);
  });
});
