import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function fixture(code: string) {
  const root = mkdtempSync(join(tmpdir(), `atm-projection-boundary-${code.toLowerCase()}-`));
  temporary.push(root);
  const manager = await AyanamiDatabaseManager.open({
    dataDir: join(root, "data"),
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: code, sourcePath: null, code });
  const projectDatabase = await manager.openProject(project.id);
  const repository = new ProjectRepository(projectDatabase);
  return { manager, project, projectDatabase, repository };
}

function scalar(sqlite: { prepare(sql: string): any }, sql: string): number {
  return Number((sqlite.prepare(sql).get() as { value: number }).value);
}

function forbiddenFacadeImports(source: string): string[] {
  return [...source.matchAll(/from\s+["']\.\/(?:index|manager|project-repository)\.js["']/gu)].map(
    (match) => match[0],
  );
}

describe("Registry projection dispatcher two-phase boundary", () => {
  it("keeps Project outbox pending when the Registry transaction fails, then retries once", async () => {
    const { manager, project, projectDatabase, repository } = await fixture("PREGF");
    repository.createRecord(
      { type: "SYSTEM", id: "projection-boundary", sessionId: null },
      "projection-registry-failure",
      {
        kind: "FACT",
        title: "Registry transaction boundary",
        summary: "Project outbox must remain pending until Registry commit succeeds",
      },
    );
    const registryState = () => ({
      summary: manager.registry.sqlite
        .prepare("SELECT * FROM project_summary_cache WHERE project_id = ?")
        .get(project.id),
      documents: manager.registry.sqlite
        .prepare("SELECT * FROM global_search_documents WHERE project_id = ? ORDER BY entity_key")
        .all(project.id),
      events: manager.registry.sqlite
        .prepare("SELECT * FROM global_events WHERE dedupe_key LIKE ? ORDER BY sequence")
        .all(`project:${project.id}:%`),
    });
    const beforeRegistry = registryState();
    manager.registry.sqlite.exec(`
      CREATE TRIGGER fail_registry_projection_event
      BEFORE INSERT ON global_events
      WHEN NEW.dedupe_key LIKE 'project:%'
      BEGIN
        SELECT RAISE(ABORT, 'injected Registry projection failure');
      END;
    `);

    await expect(manager.dispatchProject(project.id)).resolves.toMatchObject({
      delivered: 0,
      projection: {
        status: "DEFERRED",
        retryScheduled: true,
        lastError: expect.stringContaining("injected Registry projection failure"),
      },
    });
    expect(registryState()).toEqual(beforeRegistry);
    expect(
      projectDatabase.sqlite
        .prepare("SELECT delivered_at, attempts, last_error FROM outbox WHERE delivered_at IS NULL")
        .all(),
    ).toEqual([
      expect.objectContaining({
        delivered_at: null,
        attempts: 1,
        last_error: expect.stringContaining("injected Registry projection failure"),
      }),
    ]);
    expect(manager.projectionState(project.id)).toMatchObject({
      status: "DEFERRED",
      retryScheduled: true,
      retryCount: 1,
    });

    manager.registry.sqlite.exec("DROP TRIGGER fail_registry_projection_event");
    await expect(manager.dispatchProject(project.id)).resolves.toMatchObject({
      delivered: 1,
      projection: { status: "APPLIED", retryScheduled: false, lag: 0 },
    });
    expect(
      scalar(
        projectDatabase.sqlite,
        "SELECT COUNT(*) AS value FROM outbox WHERE delivered_at IS NULL",
      ),
    ).toBe(0);
    expect(
      manager.registry.sqlite
        .prepare("SELECT COUNT(*) AS value FROM global_events WHERE dedupe_key LIKE ?")
        .get(`project:${project.id}:%`),
    ).toEqual({ value: 1 });
  });

  it("retains public facade calls and performs Project ACK only after Registry projection", async () => {
    const { manager, project, repository } = await fixture("PCHAIN");
    const objectiveSpy = vi.spyOn(repository, "getActiveObjective");
    const milestoneSpy = vi.spyOn(repository, "getActiveMilestone");
    repository.summaryProjection();
    expect(objectiveSpy).toHaveBeenCalledTimes(1);
    expect(milestoneSpy).toHaveBeenCalledTimes(1);

    repository.createRecord(
      { type: "SYSTEM", id: "projection-chain", sessionId: null },
      "projection-chain-record",
      {
        kind: "FACT",
        title: "Projection chain",
        summary: "Registry commit precedes Project acknowledgement",
      },
    );
    const getProject = vi.spyOn(manager, "getProject");
    const openProject = vi.spyOn(manager, "openProject");
    const ack = vi.spyOn(ProjectRepository.prototype, "markOutboxDelivered");
    await manager.dispatchProject(project.id);
    expect(getProject).toHaveBeenCalledWith(project.id);
    expect(openProject).toHaveBeenCalledWith(project.id);
    expect(ack).toHaveBeenCalledTimes(1);
  });
});

describe("Projection source and dispatcher module boundary", () => {
  it("keeps public prototypes/private receipt seam and facade-free dependency direction", () => {
    for (const method of [
      "summaryProjection",
      "searchProjection",
      "searchProjectionForChanges",
      "pendingOutbox",
      "markOutboxDelivered",
      "markOutboxFailed",
    ]) {
      expect(Object.getOwnPropertyDescriptor(ProjectRepository.prototype, method)?.value).toEqual(
        expect.any(Function),
      );
    }
    expect(
      Object.getOwnPropertyDescriptor(AyanamiDatabaseManager.prototype, "dispatchProject")?.value,
    ).toEqual(expect.any(Function));

    const managerSource = readFileSync(
      resolve(process.cwd(), "packages/storage-sqlite/src/manager.ts"),
      "utf8",
    );
    const repositorySource = readFileSync(
      resolve(process.cwd(), "packages/storage-sqlite/src/project-repository.ts"),
      "utf8",
    );
    const source = readFileSync(
      resolve(process.cwd(), "packages/storage-sqlite/src/project-projection-source.ts"),
      "utf8",
    );
    const dispatcher = readFileSync(
      resolve(process.cwd(), "packages/storage-sqlite/src/registry-projection-dispatcher.ts"),
      "utf8",
    );
    expect(managerSource).toMatch(/private projectionReceipt\(/u);
    expect(managerSource).toMatch(/#projectionDispatcher\.dispatchProject/u);
    expect(repositorySource).toMatch(/#projectionSource\.markOutboxDelivered/u);
    expect(forbiddenFacadeImports(source)).toEqual([]);
    expect(forbiddenFacadeImports(dispatcher)).toEqual([]);
    expect(
      forbiddenFacadeImports('import { ProjectRepository } from "./project-repository.js";'),
    ).toHaveLength(1);
    expect(dispatcher).toMatch(/registry\.sqlite\.transaction/u);
    expect(dispatcher).toMatch(/markOutboxDelivered/u);
  });
});
