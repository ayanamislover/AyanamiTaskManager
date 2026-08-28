import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function fixture(code: string) {
  const root = mkdtempSync(join(tmpdir(), `atm-work-command-${code.toLowerCase()}-`));
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
    agentId: `${code.toLowerCase()}-agent`,
    displayName: `${code} Agent`,
    clientKind: "test",
    role: "SUBAGENT",
  });
  const actor = {
    type: "AGENT" as const,
    id: `${code.toLowerCase()}-agent`,
    sessionId: session.id,
  };
  return { database, repository, session, actor };
}

function scalar(
  database: Awaited<ReturnType<AyanamiDatabaseManager["openProject"]>>,
  sql: string,
): number {
  return Number((database.sqlite.prepare(sql).get() as { value: number }).value);
}

function mutationCounts(database: Awaited<ReturnType<AyanamiDatabaseManager["openProject"]>>) {
  return {
    sequence: scalar(
      database,
      "SELECT current_sequence AS value FROM project_meta WHERE singleton = 1",
    ),
    events: scalar(database, "SELECT COUNT(*) AS value FROM events"),
    outbox: scalar(database, "SELECT COUNT(*) AS value FROM outbox"),
    idempotency: scalar(database, "SELECT COUNT(*) AS value FROM idempotency_keys"),
  };
}

describe("WorkItem and Checklist command transaction boundaries", () => {
  it("rolls back planning root, graph, counters, search and idempotency when create outbox fails", async () => {
    const { database, repository, actor } = await fixture("WCREATE");
    const state = () => ({
      ...mutationCounts(database),
      objectives: scalar(database, "SELECT COUNT(*) AS value FROM objectives"),
      milestones: scalar(database, "SELECT COUNT(*) AS value FROM milestones"),
      workItems: scalar(database, "SELECT COUNT(*) AS value FROM work_items"),
      checklist: scalar(database, "SELECT COUNT(*) AS value FROM checklist_items"),
      relations: scalar(database, "SELECT COUNT(*) AS value FROM work_item_relations"),
      search: scalar(database, "SELECT COUNT(*) AS value FROM search_documents"),
      counters: database.sqlite
        .prepare(
          "SELECT name, next_value FROM counters WHERE name IN ('objective','milestone','work_item') ORDER BY name",
        )
        .all(),
    });
    const before = state();
    database.sqlite.exec(`
      CREATE TRIGGER fail_work_create_outbox
      BEFORE INSERT ON outbox
      WHEN NEW.payload_json LIKE '%work.created%'
      BEGIN
        SELECT RAISE(ABORT, 'injected work create outbox failure');
      END;
    `);
    const items = [
      {
        clientRef: "parent",
        title: "Parent",
        type: "TASK",
        priority: "NORMAL",
        status: "READY" as const,
        checklist: [{ title: "Acceptance", evidenceRequired: true }],
      },
      {
        clientRef: "child",
        parentRef: "parent",
        dependsOnRefs: ["parent"],
        discoveredFromRef: "parent",
        title: "Child",
        type: "SUBTASK",
        priority: "HIGH",
        status: "BACKLOG" as const,
      },
    ];
    const planningRoot = {
      provisionIfMissing: true,
      objectiveTitle: "Managed objective",
      objectiveDescription: "Atomic planning root",
      milestoneTitle: "Managed milestone",
    };

    expect(() =>
      repository.createWorkItems(actor, "work-create-failure", items, planningRoot),
    ).toThrow("injected work create outbox failure");
    expect(state()).toEqual(before);

    database.sqlite.exec("DROP TRIGGER fail_work_create_outbox");
    expect(
      repository.createWorkItems(actor, "work-create-failure", items, planningRoot),
    ).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ title: "Parent" })]),
      planningRootProvisioned: true,
    });
  });

  it("rolls back task, Session and lifecycle timestamps when patch outbox fails", async () => {
    const { database, repository, session, actor } = await fixture("WPATCH");
    const objective = repository.createObjective(actor, {
      title: "Patch objective",
      description: "",
      definitionOfDone: [],
    });
    const created = repository.createWorkItems(actor, "patch-create", [
      {
        clientRef: "task",
        objectiveId: objective.id,
        title: "Patch task",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
      },
    ]).items[0]!;
    const state = () => ({
      task: database.sqlite
        .prepare(
          `SELECT status, phase, assignee_agent_id, claimed_by_session_id, claim_lease_until,
                  ever_claimed_at, last_started_at, version
           FROM work_items WHERE local_no = ?`,
        )
        .get(created.localNo),
      session: database.sqlite
        .prepare(
          "SELECT work_state, current_work_item_id, version FROM agent_sessions WHERE id = ?",
        )
        .get(session.id),
      counts: mutationCounts(database),
    });
    const before = state();
    database.sqlite.exec(`
      CREATE TRIGGER fail_work_patch_outbox
      BEFORE INSERT ON outbox
      WHEN NEW.payload_json LIKE '%work.started%'
      BEGIN
        SELECT RAISE(ABORT, 'injected work patch outbox failure');
      END;
    `);

    expect(() =>
      repository.patchWorkItems(actor, "work-patch-failure", [
        { taskKey: created.key, expectedVersion: created.version, operation: "start" },
      ]),
    ).toThrow("injected work patch outbox failure");
    expect(state()).toEqual(before);

    database.sqlite.exec("DROP TRIGGER fail_work_patch_outbox");
    expect(
      repository.patchWorkItems(actor, "work-patch-failure", [
        { taskKey: created.key, expectedVersion: created.version, operation: "start" },
      ]).items[0],
    ).toMatchObject({ status: "IN_PROGRESS", claimedBySessionId: session.id });
  });

  it("rolls back checklist, task progress and evidence timestamp when checklist outbox fails", async () => {
    const { database, repository, actor } = await fixture("WCHK");
    const objective = repository.createObjective(actor, {
      title: "Checklist objective",
      description: "",
      definitionOfDone: [],
    });
    const created = repository.createWorkItems(actor, "checklist-create", [
      {
        clientRef: "task",
        objectiveId: objective.id,
        title: "Checklist task",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
        checklist: [{ title: "Proof", evidenceRequired: true }],
      },
    ]).items[0]!;
    const checklist = repository.getWorkItem(created.key).checklist[0]!;
    const state = () => ({
      checklist: database.sqlite
        .prepare("SELECT status, evidence_json, version FROM checklist_items WHERE id = ?")
        .get(checklist.id),
      task: database.sqlite
        .prepare(
          "SELECT computed_progress, progress_source, last_evidence_at, version FROM work_items WHERE local_no = ?",
        )
        .get(created.localNo),
      counts: mutationCounts(database),
    });
    const before = state();
    database.sqlite.exec(`
      CREATE TRIGGER fail_checklist_outbox
      BEFORE INSERT ON outbox
      WHEN NEW.payload_json LIKE '%checklist.updated%'
      BEGIN
        SELECT RAISE(ABORT, 'injected checklist outbox failure');
      END;
    `);

    expect(() =>
      repository.updateChecklist(actor, "checklist-failure", {
        checklistId: checklist.id,
        expectedVersion: checklist.version,
        status: "DONE",
        evidence: ["proof"],
      }),
    ).toThrow("injected checklist outbox failure");
    expect(state()).toEqual(before);

    database.sqlite.exec("DROP TRIGGER fail_checklist_outbox");
    expect(
      repository.updateChecklist(actor, "checklist-failure", {
        checklistId: checklist.id,
        expectedVersion: checklist.version,
        status: "DONE",
        evidence: ["proof"],
      }),
    ).toMatchObject({ checklist: { status: "DONE", evidence: ["proof"] } });
  });

  it("rolls back progress, blocker counter, task evidence and search on progress outbox failure", async () => {
    const { database, repository, actor } = await fixture("WPROG");
    const objective = repository.createObjective(actor, {
      title: "Progress objective",
      description: "",
      definitionOfDone: [],
    });
    let task = repository.createWorkItems(actor, "progress-create", [
      {
        clientRef: "task",
        objectiveId: objective.id,
        title: "Progress task",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
      },
    ]).items[0]!;
    task = repository.patchWorkItems(actor, "progress-start", [
      { taskKey: task.key, expectedVersion: task.version, operation: "start" },
    ]).items[0]!;
    const state = () => ({
      task: database.sqlite
        .prepare(
          `SELECT status, phase, blocked_reason, reported_progress, computed_progress,
                  last_evidence_at, version FROM work_items WHERE local_no = ?`,
        )
        .get(task.localNo),
      progress: scalar(database, "SELECT COUNT(*) AS value FROM progress_updates"),
      blockers: scalar(database, "SELECT COUNT(*) AS value FROM blockers"),
      blockerCounter: database.sqlite
        .prepare("SELECT next_value FROM counters WHERE name = 'blocker'")
        .get(),
      search: scalar(database, "SELECT COUNT(*) AS value FROM search_documents"),
      counts: mutationCounts(database),
    });
    const before = state();
    database.sqlite.exec(`
      CREATE TRIGGER fail_progress_outbox
      BEFORE INSERT ON outbox
      WHEN NEW.payload_json LIKE '%work.blocked%'
      BEGIN
        SELECT RAISE(ABORT, 'injected progress outbox failure');
      END;
    `);

    expect(() =>
      repository.addProgress(actor, "progress-failure", {
        taskKey: task.key,
        percent: 40,
        summary: "Blocked with evidence",
        blocker: "Injected blocker",
        evidence: ["proof"],
      }),
    ).toThrow("injected progress outbox failure");
    expect(state()).toEqual(before);

    database.sqlite.exec("DROP TRIGGER fail_progress_outbox");
    expect(
      repository.addProgress(actor, "progress-failure", {
        taskKey: task.key,
        percent: 40,
        summary: "Blocked with evidence",
        blocker: "Injected blocker",
        evidence: ["proof"],
      }),
    ).toMatchObject({ ok: 1, key: task.key });
    expect(scalar(database, "SELECT COUNT(*) AS value FROM blockers")).toBe(before.blockers + 1);
  });
});

describe("WorkItem command facade and dependency boundary", () => {
  it("keeps public methods/private helper seams and command modules facade-free", () => {
    for (const method of [
      "createObjective",
      "createMilestone",
      "createWorkItems",
      "patchWorkItems",
      "verifyAndComplete",
      "resolveActiveBlockers",
      "updateChecklist",
      "updateChecklistBatch",
      "addProgress",
    ]) {
      expect(Object.getOwnPropertyDescriptor(ProjectRepository.prototype, method)?.value).toEqual(
        expect.any(Function),
      );
    }
    const repositorySource = readFileSync(
      resolve(process.cwd(), "packages/storage-sqlite/src/project-repository.ts"),
      "utf8",
    );
    for (const helper of [
      "recordWorkItemLifecycleAt",
      "advanceWorkItemEvidenceAt",
      "normalizeEvidence",
      "recomputeWorkItem",
      "upsertSearchDocument",
      "refreshWorkItemSearchDocument",
    ]) {
      expect(repositorySource).toMatch(new RegExp(`private ${helper}\\(`, "u"));
    }
    for (const file of [
      "checklist-commands.ts",
      "evidence-normalizer.ts",
      "planning-commands.ts",
      "progress-commands.ts",
      "work-item-create-commands.ts",
      "work-item-lifecycle-commands.ts",
      "work-item-maintenance.ts",
      "work-item-operation.ts",
    ]) {
      const source = readFileSync(
        resolve(process.cwd(), "packages/storage-sqlite/src", file),
        "utf8",
      );
      expect(source).not.toMatch(/from\s+["']\.\/(?:index|manager|project-repository)\.js["']/u);
      expect(source).not.toMatch(/#sqlite\.transaction/u);
    }
    const lifecycle = readFileSync(
      resolve(process.cwd(), "packages/storage-sqlite/src/work-item-lifecycle-commands.ts"),
      "utf8",
    );
    expect(lifecycle).not.toMatch(/review_submissions|ReviewRequest|submitReview/u);
  });
});
