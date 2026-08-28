import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository, requestFingerprint } from "../src/index.js";

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function fixture(code: string) {
  const root = mkdtempSync(join(tmpdir(), `atm-mutation-kernel-${code.toLowerCase()}-`));
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
  return { database, repository, actor };
}

function mutationState(database: Awaited<ReturnType<AyanamiDatabaseManager["openProject"]>>) {
  const scalar = (sql: string, field: string) =>
    (database.sqlite.prepare(sql).get() as Record<string, number>)[field];
  return {
    objectives: scalar("SELECT COUNT(*) AS value FROM objectives", "value"),
    objectiveCounter: scalar(
      "SELECT next_value AS value FROM counters WHERE name = 'objective'",
      "value",
    ),
    projectSequence: scalar(
      "SELECT current_sequence AS value FROM project_meta WHERE singleton = 1",
      "value",
    ),
    events: scalar("SELECT COUNT(*) AS value FROM events", "value"),
    outbox: scalar("SELECT COUNT(*) AS value FROM outbox", "value"),
    idempotency: scalar("SELECT COUNT(*) AS value FROM idempotency_keys", "value"),
  };
}

const objectiveInput = {
  title: "Atomic objective",
  description: "Mutation kernel transaction characterization",
  definitionOfDone: ["All writes commit atomically"],
};

describe("Project mutation kernel transaction boundary", () => {
  it("rolls back domain, counter, sequence and event when event-to-outbox append fails", async () => {
    const { database, repository, actor } = await fixture("KOUT");
    const before = mutationState(database);
    database.sqlite.exec(`
      CREATE TRIGGER fail_objective_outbox
      BEFORE INSERT ON outbox
      WHEN NEW.payload_json LIKE '%objective.created%'
      BEGIN
        SELECT RAISE(ABORT, 'injected objective outbox failure');
      END;
    `);

    expect(() =>
      repository.createObjective(actor, objectiveInput, "kernel-outbox-failure"),
    ).toThrow("injected objective outbox failure");
    expect(mutationState(database)).toEqual(before);

    database.sqlite.exec("DROP TRIGGER fail_objective_outbox");
    const created = repository.createObjective(actor, objectiveInput, "kernel-outbox-failure");
    expect(created).toMatchObject({
      localNo: before.objectiveCounter,
      sequence: before.projectSequence + 1,
    });
    expect(
      database.sqlite.prepare("SELECT op_id FROM events WHERE type = 'objective.created'").get(),
    ).toEqual({ op_id: "kernel-outbox-failure" });
  });

  it("rolls back domain, counter, sequence, event and outbox when idempotency write fails", async () => {
    const { database, repository, actor } = await fixture("KIDEM");
    const before = mutationState(database);
    database.sqlite.exec(`
      CREATE TRIGGER fail_objective_idempotency
      BEFORE INSERT ON idempotency_keys
      WHEN NEW.operation = 'objective.create'
      BEGIN
        SELECT RAISE(ABORT, 'injected objective idempotency failure');
      END;
    `);

    expect(() =>
      repository.createObjective(actor, objectiveInput, "kernel-idempotency-failure"),
    ).toThrow("injected objective idempotency failure");
    expect(mutationState(database)).toEqual(before);

    database.sqlite.exec("DROP TRIGGER fail_objective_idempotency");
    repository.createObjective(actor, objectiveInput, "kernel-idempotency-failure");
    expect(
      database.sqlite
        .prepare("SELECT op_id, actor_session_id FROM idempotency_keys WHERE operation = ?")
        .get("objective.create"),
    ).toEqual({ op_id: "kernel-idempotency-failure", actor_session_id: actor.sessionId });
  });

  it("returns the cached response without re-executing the action on exact replay", async () => {
    const { database, repository, actor } = await fixture("KREPLAY");
    const first = repository.createObjective(actor, objectiveInput, "kernel-exact-replay");
    const afterFirst = mutationState(database);
    database.sqlite.exec(`
      CREATE TRIGGER reject_replayed_objective_action
      BEFORE INSERT ON objectives
      BEGIN
        SELECT RAISE(ABORT, 'replay executed action');
      END;
    `);

    const replay = repository.createObjective(actor, objectiveInput, "kernel-exact-replay");
    expect(replay).toEqual(first);
    expect(mutationState(database)).toEqual(afterFirst);
  });
});

describe("Project mutation kernel module boundary", () => {
  it("keeps public exports and facade forwarding seams while the kernel uniquely owns mutation state", () => {
    expect(requestFingerprint({ b: 2, a: 1 })).toBe(requestFingerprint({ a: 1, b: 2 }));
    expect(
      Object.getOwnPropertyDescriptor(ProjectRepository.prototype, "createObjective")?.value,
    ).toEqual(expect.any(Function));

    const repositorySource = readFileSync(
      resolve(process.cwd(), "packages/storage-sqlite/src/project-repository.ts"),
      "utf8",
    );
    const kernelSource = readFileSync(
      resolve(process.cwd(), "packages/storage-sqlite/src/project-mutation-kernel.ts"),
      "utf8",
    );
    expect(repositorySource).not.toMatch(/#activeOperationId/u);
    expect(repositorySource).not.toMatch(/INSERT INTO idempotency_keys/u);
    expect(repositorySource).not.toMatch(/INSERT INTO events\(/u);
    expect(repositorySource).not.toMatch(/INSERT INTO outbox\(/u);
    expect(repositorySource).toMatch(/private nextNumber[\s\S]*?#mutation\.nextNumber/u);
    expect(repositorySource).toMatch(/private appendEvent[\s\S]*?#mutation\.appendEvent/u);
    expect(repositorySource).toMatch(/private mutate<[\s\S]*?#mutation\.mutate\(/u);
    expect(repositorySource).toMatch(
      /private mutateWithReplay<[\s\S]*?#mutation\.mutateWithReplay/u,
    );

    expect(kernelSource).toMatch(/#activeOperationId/u);
    expect(kernelSource).toMatch(/INSERT INTO idempotency_keys/u);
    expect(kernelSource).toMatch(/INSERT INTO events\(/u);
    expect(kernelSource).toMatch(/INSERT INTO outbox\(/u);
    expect(kernelSource).not.toMatch(
      /from\s+["']\.\/(?:index|manager|project-repository)\.js["']/u,
    );
  });
});
