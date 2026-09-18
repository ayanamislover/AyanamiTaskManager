import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, encodeTaskListCursor, ProjectRepository } from "../src/index.js";
import { captureAtmError } from "./typed-error-test-helpers.js";

// 项目任务列表默认只显示未结束的任务和最近结束的几项，其余已结束任务按需往下加载。
// 实测一个项目 361 个任务里 353 个已结束，全部拉下来渲染正是首屏抽动的来源。

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

async function fixture(code: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-recent-closed-"));
  temporary.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: "最近结束", sourcePath: null, code });
  const database = await manager.openProject(project.id);
  const repository = new ProjectRepository(database);
  const session = repository.createSession({
    agentId: "closed-agent",
    displayName: "Closed Agent",
    clientKind: "test",
    role: "SUBAGENT",
  });
  const actor = { type: "AGENT" as const, id: "closed-agent", sessionId: session.id };
  const objective = repository.createObjective(actor, {
    title: "分组",
    description: "",
    definitionOfDone: [],
  });
  return { database, repository, actor, objective };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function createTasks({ repository, actor, objective }: Fixture, titles: string[]) {
  return repository.createWorkItems(
    actor,
    `create-${titles.join("-")}`,
    titles.map((title) => ({
      clientRef: title,
      objectiveId: objective.id,
      title,
      type: "TASK" as const,
      priority: "NORMAL" as const,
      status: "READY" as const,
    })),
  ).items;
}

function finish(
  { repository, actor }: Fixture,
  task: { key: string; version: number },
  how: "complete" | "cancel",
) {
  let current = task;
  if (how === "complete") {
    current = repository.patchWorkItems(actor, `start-${task.key}`, [
      { taskKey: task.key, expectedVersion: current.version, operation: "start" },
    ]).items[0]!;
    repository.patchWorkItems(actor, `complete-${task.key}`, [
      { taskKey: task.key, expectedVersion: current.version, operation: "complete" },
    ]);
  } else {
    repository.patchWorkItems(actor, `cancel-${task.key}`, [
      {
        taskKey: task.key,
        expectedVersion: current.version,
        operation: "cancel",
        cancelReason: "不再需要",
      },
    ]);
  }
}

// 同一次测试里的完成时间可能落在同一毫秒，排序断言需要确定的时间。
function setFinishedAt(fixtureValue: Fixture, key: string, at: string) {
  const localNo = Number(key.split("-").at(-1));
  fixtureValue.database.sqlite
    .prepare(
      `UPDATE work_items
       SET completed_at = CASE WHEN status = 'DONE' THEN ? ELSE NULL END, updated_at = ?
       WHERE local_no = ?`,
    )
    .run(at, at, localNo);
}

describe("按结束状态分组的任务列表", () => {
  it("closed 参数把任务分成未结束与已结束两组，省略时两组都在", async () => {
    const value = await fixture("GRP");
    const [open, done, cancelled] = createTasks(value, ["进行", "完成", "取消"]);
    finish(value, done!, "complete");
    finish(value, cancelled!, "cancel");

    const keys = (closed?: boolean) =>
      value.repository
        .listWorkItemPage({ limit: 100, ...(closed === undefined ? {} : { closed }) })
        .items.map((task) => task.key)
        .sort();
    expect(keys(false)).toEqual([open!.key]);
    expect(keys(true)).toEqual([cancelled!.key, done!.key].sort());
    expect(keys()).toEqual([open!.key, done!.key, cancelled!.key].sort());
  });

  it("分组游标只在本组内有效，不带分组的旧游标在升级后仍然可用", async () => {
    const value = await fixture("CUR");
    const tasks = createTasks(value, ["一", "二", "三"]);
    finish(value, tasks[0]!, "complete");

    const openPage = value.repository.listWorkItemPage({ limit: 1, closed: false });
    expect(openPage.hasMore).toBe(true);
    expect(
      captureAtmError(() =>
        value.repository.listWorkItemPage({ limit: 1, closed: true, cursor: openPage.nextCursor! }),
      ),
    ).toMatchObject({ code: "INVALID_CURSOR" });

    // 升级前发出的 cursor 里没有分组字段。下面这串是加分组参数之前的代码对同一选择集算出的原文，
    // 不分组时必须逐字相同，否则 Agent 手里还没用完的 cursor 会在升级后全部失效。
    const selection = {
      status: null,
      owner: null,
      parent: null,
      milestone: null,
      ready: false,
      query: null,
    };
    const beforeUpgrade =
      "tl1.eyJ2IjoxLCJwIjoiQ1VSIiwicyI6IjM3Zks5V3Y4WWNpd25HZXJ1cDAxZ1MiLCJsIjpudWxsfQ.DsSB0Cwj6-2umNfhL6NNRH";
    expect(encodeTaskListCursor({ project: "CUR", selection, last: null })).toBe(beforeUpgrade);
    expect(
      encodeTaskListCursor({
        project: "CUR",
        selection: { ...selection, closed: null },
        last: null,
      }),
    ).toBe(beforeUpgrade);
    const legacy = value.repository.listWorkItemPage({ limit: 1 });
    expect(
      value.repository.listWorkItemPage({ limit: 1, cursor: legacy.nextCursor! }).items,
    ).toHaveLength(1);
  });
});

describe("最近结束的任务", () => {
  it("按结束时间倒序分页，同一时刻按编号倒序，附带总数且不重不漏", async () => {
    const value = await fixture("RCT");
    const tasks = createTasks(value, ["t1", "t2", "t3", "t4", "t5", "t6"]);
    for (const [index, task] of tasks.entries()) {
      if (index === 5) continue; // 第六个保持未结束，不能出现在结果里
      finish(value, task, index === 2 ? "cancel" : "complete");
    }
    const [t1, t2, t3, t4, t5] = tasks;
    setFinishedAt(value, t1!.key, "2026-09-10T00:00:00.000Z");
    setFinishedAt(value, t2!.key, "2026-09-12T00:00:00.000Z");
    setFinishedAt(value, t3!.key, "2026-09-14T00:00:00.000Z"); // 取消：没有 completed_at，用 updated_at
    setFinishedAt(value, t4!.key, "2026-09-12T00:00:00.000Z"); // 与 t2 同一时刻
    setFinishedAt(value, t5!.key, "2026-09-11T00:00:00.000Z");

    const expected = [t3!.key, t4!.key, t2!.key, t5!.key, t1!.key];
    const first = value.repository.listRecentClosedWorkItemPage({ limit: 2 });
    expect(first.items.map((task) => task.key)).toEqual(expected.slice(0, 2));
    expect(first.total).toBe(5);
    expect(first.hasMore).toBe(true);

    const seen = first.items.map((task) => task.key);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = value.repository.listRecentClosedWorkItemPage({ limit: 2, cursor });
      expect(page.total).toBe(5);
      seen.push(...page.items.map((task) => task.key));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(expected);
  });

  it("篡改过或属于别的项目的游标被拒绝", async () => {
    const value = await fixture("TMP");
    const tasks = createTasks(value, ["a", "b"]);
    for (const task of tasks) finish(value, task, "complete");
    const page = value.repository.listRecentClosedWorkItemPage({ limit: 1 });
    const [prefix, body, signature] = page.nextCursor!.split(".");
    const forged = `${prefix}.${Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString("utf8")), n: 999 }),
    ).toString("base64url")}.${signature}`;
    expect(
      captureAtmError(() => value.repository.listRecentClosedWorkItemPage({ cursor: forged })),
    ).toMatchObject({ code: "INVALID_CURSOR" });

    const other = await fixture("OTH");
    expect(
      captureAtmError(() =>
        other.repository.listRecentClosedWorkItemPage({ cursor: page.nextCursor! }),
      ),
    ).toMatchObject({ code: "INVALID_CURSOR" });
  });
});
