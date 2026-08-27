import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];
const services: AyanamiTaskService[] = [];
const connections: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of connections.splice(0)) await close();
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

type MutationSnapshot = {
  objectives: number;
  milestones: number;
  workItems: number;
  relations: number;
  events: number;
  outbox: number;
  idempotency: number;
  sequence: number;
};

function rowCount(database: { sqlite: any }, table: string): number {
  return Number(
    (database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
      .count,
  );
}

function mutationSnapshot(database: { sqlite: any }): MutationSnapshot {
  const meta = database.sqlite
    .prepare("SELECT current_sequence FROM project_meta WHERE singleton = 1")
    .get() as { current_sequence: number };
  return {
    objectives: rowCount(database, "objectives"),
    milestones: rowCount(database, "milestones"),
    workItems: rowCount(database, "work_items"),
    relations: rowCount(database, "work_item_relations"),
    events: rowCount(database, "events"),
    outbox: rowCount(database, "outbox"),
    idempotency: rowCount(database, "idempotency_keys"),
    sequence: Number(meta.current_sequence),
  };
}

function task(clientRef: string, overrides: Record<string, unknown> = {}) {
  return {
    client_ref: clientRef,
    title: `任务 ${clientRef}`,
    description: "规划根与任务必须在同一事务内创建",
    type: "TASK",
    priority: "NORMAL",
    status: "READY",
    depends_on: [],
    depends_on_refs: [],
    acceptance: [],
    checklist: [],
    verification_required: false,
    ...overrides,
  };
}

async function openEmptyProject(code: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-planning-atomicity-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  services.push(service);
  const project = await service.createProject({
    name: `Atomic planning ${code}`,
    sourcePath: null,
    code,
  });
  const begun = await service.begin({
    projectCode: project.code,
    mode: "project",
    agentId: `planning-atomicity-${code.toLowerCase()}`,
    clientKind: "test",
    role: "PRIMARY",
  });
  const profiles = await connectProfiledClients(service, `planning-atomicity-${code}`);
  connections.push(profiles.close);
  const database = await service.databases.openProject(project.code);
  return { service, project, session: String(begun.session), profiles, database };
}

async function expectRejectedWithoutWrites(input: {
  code: string;
  opId: string;
  items: Record<string, unknown>[];
  errorCode: string;
}) {
  const fixture = await openEmptyProject(input.code);
  const before = mutationSnapshot(fixture.database);
  const response = await fixture.profiles.client.callTool({
    name: "atm_task_create",
    arguments: {
      project: fixture.project.code,
      session: fixture.session,
      op_id: input.opId,
      items: input.items,
    },
  });

  expect(response.isError).toBe(true);
  expect(JSON.stringify(response.content)).toContain(input.errorCode);
  expect(mutationSnapshot(fixture.database)).toEqual(before);
}

describe("planning-root + task-create atomicity", () => {
  it("rejects an unknown depends_on_ref without provisioning any planning state", async () => {
    await expectRejectedWithoutWrites({
      code: "DREF",
      opId: "planning-root-invalid-dependency-ref",
      items: [task("dependent", { depends_on_refs: ["missing-task"] })],
      errorCode: "DEPENDENCY_REF_NOT_FOUND",
    });
  });

  it("rejects a dependency cycle without provisioning any planning state", async () => {
    await expectRejectedWithoutWrites({
      code: "DCYCLE",
      opId: "planning-root-dependency-cycle",
      items: [
        task("first", { depends_on_refs: ["second"] }),
        task("second", { depends_on_refs: ["first"] }),
      ],
      errorCode: "DEPENDENCY_CYCLE",
    });
  });

  it("rejects duplicate client_ref values without provisioning any planning state", async () => {
    await expectRejectedWithoutWrites({
      code: "DUPREF",
      opId: "planning-root-duplicate-client-ref",
      items: [task("same"), task("same")],
      errorCode: "VALIDATION_ERROR",
    });
  });

  it.each([
    {
      code: "PREF",
      opId: "planning-root-invalid-parent-ref",
      items: [task("child", { parent_ref: "missing-parent" })],
      errorCode: "PARENT_REF_NOT_FOUND",
    },
    {
      code: "DISCREF",
      opId: "planning-root-invalid-discovered-ref",
      items: [task("follow-up", { discovered_from_ref: "missing-source" })],
      errorCode: "DISCOVERED_FROM_REF_NOT_FOUND",
    },
  ])("rejects $errorCode without provisioning any planning state", async (input) => {
    await expectRejectedWithoutWrites(input);
  });

  it("rejects a milestone owned by another objective with zero side effects", async () => {
    const fixture = await openEmptyProject("XMILE");
    const firstObjective = await fixture.service.createObjectiveAsUser(
      fixture.project.code,
      "cross-milestone-objective-1",
      { title: "目标一", description: "", definitionOfDone: [] },
    );
    const secondObjective = await fixture.service.createObjectiveAsUser(
      fixture.project.code,
      "cross-milestone-objective-2",
      { title: "目标二", description: "", definitionOfDone: [] },
    );
    const secondMilestone = await fixture.service.createMilestoneAsUser(
      fixture.project.code,
      "cross-milestone-milestone-2",
      { objectiveId: String(secondObjective.id), title: "目标二里程碑" },
    );
    const before = mutationSnapshot(fixture.database);

    const response = await fixture.profiles.client.callTool({
      name: "atm_task_create",
      arguments: {
        project: fixture.project.code,
        session: fixture.session,
        op_id: "cross-objective-milestone-task",
        items: [
          task("cross-objective", {
            objective_id: String(firstObjective.id),
            milestone_id: String(secondMilestone.id),
          }),
        ],
      },
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain("MILESTONE_OBJECTIVE_MISMATCH");
    expect(mutationSnapshot(fixture.database)).toEqual(before);
  });

  it("resolves forward parent/dependency/discovery refs and replays the exact receipt", async () => {
    const fixture = await openEmptyProject("FREF");
    const payload = {
      project: fixture.project.code,
      session: fixture.session,
      op_id: "forward-graph-create",
      items: [
        task("dependent", {
          parent_ref: "parent",
          depends_on_refs: ["dependency"],
          discovered_from_ref: "source",
        }),
        task("parent", { type: "EPIC" }),
        task("dependency"),
        task("source"),
      ],
    };
    const created = await fixture.profiles.client.callTool({
      name: "atm_task_create",
      arguments: payload,
    });
    expect(created.isError, JSON.stringify(created.content)).not.toBe(true);
    const firstReceipt = created.structuredContent as Record<string, any>;
    const trace = await fixture.profiles.memoryClient.callTool({
      name: "atm_search",
      arguments: {
        project: fixture.project.code,
        op_id: payload.op_id,
        session: fixture.session,
        max_chars: 50_000,
      },
    });
    expect(
      (trace.structuredContent as Record<string, any>).operation.mutations[0].response,
    ).toMatchObject({ planningRootProvisioned: true });

    const replayed = await fixture.profiles.client.callTool({
      name: "atm_task_create",
      arguments: payload,
    });
    expect(replayed.structuredContent).toEqual(firstReceipt);

    const keys = new Map(
      ["dependent", "parent", "dependency", "source"].map((clientRef, index) => [
        clientRef,
        String(firstReceipt.entities[index]!.key),
      ]),
    );
    const localNo = (reference: string) => Number(reference.slice(reference.lastIndexOf("-") + 1));
    const dependentRow = fixture.database.sqlite
      .prepare("SELECT id, parent_id FROM work_items WHERE local_no = ?")
      .get(localNo(keys.get("dependent")!)) as { id: string; parent_id: string };
    const parentRow = fixture.database.sqlite
      .prepare("SELECT local_no FROM work_items WHERE id = ?")
      .get(dependentRow.parent_id) as { local_no: number };
    const dependencyRows = fixture.database.sqlite
      .prepare(
        `SELECT source.local_no FROM work_item_relations relation
         JOIN work_items source ON source.id = relation.source_id
         WHERE relation.target_id = ? AND relation.relation_type = 'BLOCKS'`,
      )
      .all(dependentRow.id) as Array<{ local_no: number }>;
    const discoveredRow = fixture.database.sqlite
      .prepare(
        `SELECT target.local_no FROM work_item_relations relation
         JOIN work_items target ON target.id = relation.target_id
         WHERE relation.source_id = ? AND relation.relation_type = 'DISCOVERED_FROM'`,
      )
      .get(dependentRow.id) as { local_no: number };
    const keyFor = (number: number) =>
      `${fixture.project.code}-T-${String(number).padStart(4, "0")}`;
    expect(keyFor(parentRow.local_no)).toBe(keys.get("parent"));
    expect(dependencyRows.map((row) => keyFor(row.local_no))).toEqual([keys.get("dependency")]);
    expect(keyFor(discoveredRow.local_no)).toBe(keys.get("source"));
    expect(await fixture.service.listObjectives(fixture.project.code)).toHaveLength(1);
    expect(await fixture.service.listMilestones(fixture.project.code)).toHaveLength(1);
    expect(await fixture.service.listWorkItems(fixture.project.code, { limit: 20 })).toHaveLength(
      4,
    );
    expect(rowCount(fixture.database, "idempotency_keys")).toBe(1);
  });

  it("serializes concurrent first batches so exactly one planning root is created", async () => {
    const fixture = await openEmptyProject("CONROOT");
    const second = await fixture.service.begin({
      projectCode: fixture.project.code,
      mode: "project",
      agentId: "planning-atomicity-conroot-second",
      clientKind: "test",
      role: "SUBAGENT",
    });
    const create = (session: string, opId: string, clientRef: string) =>
      fixture.profiles.client.callTool({
        name: "atm_task_create",
        arguments: {
          project: fixture.project.code,
          session,
          op_id: opId,
          items: [task(clientRef)],
        },
      });

    const receipts = await Promise.all([
      create(fixture.session, "concurrent-root-first", "first"),
      create(String(second.session), "concurrent-root-second", "second"),
    ]);
    expect(receipts.every((receipt) => receipt.isError !== true)).toBe(true);
    const traces = await Promise.all(
      receipts.map((receipt) => {
        const acknowledgement = receipt.structuredContent as Record<string, any>;
        return fixture.profiles.memoryClient.callTool({
          name: "atm_search",
          arguments: {
            project: fixture.project.code,
            op_id: acknowledgement.op_id,
            session: acknowledgement.session,
            max_chars: 20_000,
          },
        });
      }),
    );
    expect(
      traces.filter(
        (trace) =>
          (trace.structuredContent as Record<string, any>).operation.mutations[0].response
            .planningRootProvisioned === true,
      ),
    ).toHaveLength(1);
    expect(await fixture.service.listObjectives(fixture.project.code)).toHaveLength(1);
    expect(await fixture.service.listMilestones(fixture.project.code)).toHaveLength(1);
    expect(await fixture.service.listWorkItems(fixture.project.code, { limit: 20 })).toHaveLength(
      2,
    );
    expect(rowCount(fixture.database, "idempotency_keys")).toBe(2);
  });
});
