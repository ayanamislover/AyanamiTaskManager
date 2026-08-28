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
  const root = mkdtempSync(join(tmpdir(), `atm-session-commands-${code.toLowerCase()}-`));
  temporary.push(root);
  const manager = await AyanamiDatabaseManager.open({
    dataDir: join(root, "data"),
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: code, sourcePath: null, code });
  const database = await manager.openProject(project.code);
  return { database, repository: new ProjectRepository(database) };
}

function sessionInput(code: string) {
  return {
    agentId: `${code.toLowerCase()}-agent`,
    displayName: `${code} Agent`,
    clientKind: "test",
    role: "SUBAGENT" as const,
    cwd: `R:\\${code}`,
  };
}

function mutationCounts(database: Awaited<ReturnType<AyanamiDatabaseManager["openProject"]>>) {
  const scalar = (sql: string) => (database.sqlite.prepare(sql).get() as { value: number }).value;
  return {
    sequence: scalar("SELECT current_sequence AS value FROM project_meta WHERE singleton = 1"),
    events: scalar("SELECT COUNT(*) AS value FROM events"),
    outbox: scalar("SELECT COUNT(*) AS value FROM outbox"),
    idempotency: scalar("SELECT COUNT(*) AS value FROM idempotency_keys"),
  };
}

describe("Session command transaction boundaries", () => {
  it("rolls back agent and Session creation when agent.joined outbox append fails", async () => {
    const { database, repository } = await fixture("SCREATE");
    const before = {
      ...mutationCounts(database),
      agents: database.sqlite.prepare("SELECT COUNT(*) AS value FROM agents").get(),
      sessions: database.sqlite.prepare("SELECT COUNT(*) AS value FROM agent_sessions").get(),
    };
    database.sqlite.exec(`
      CREATE TRIGGER fail_session_create_outbox
      BEFORE INSERT ON outbox
      WHEN NEW.payload_json LIKE '%agent.joined%'
      BEGIN
        SELECT RAISE(ABORT, 'injected session create outbox failure');
      END;
    `);

    expect(() => repository.createSession(sessionInput("SCREATE"))).toThrow(
      "injected session create outbox failure",
    );
    expect({
      ...mutationCounts(database),
      agents: database.sqlite.prepare("SELECT COUNT(*) AS value FROM agents").get(),
      sessions: database.sqlite.prepare("SELECT COUNT(*) AS value FROM agent_sessions").get(),
    }).toEqual(before);

    database.sqlite.exec("DROP TRIGGER fail_session_create_outbox");
    expect(repository.createSession(sessionInput("SCREATE"))).toMatchObject({ sequence: 1 });
  });

  it("makes Git context update atomic and preserves the event-free no-op path", async () => {
    const { database, repository } = await fixture("SGIT");
    const session = repository.createSession(sessionInput("SGIT"));
    const sessionRow = () =>
      database.sqlite
        .prepare(
          `SELECT git_branch, git_head, git_repo_root, worktree_root, git_common_dir,
                  git_is_linked_worktree, git_detached, git_dirty, git_available, git_error, version
           FROM agent_sessions WHERE id = ?`,
        )
        .get(session.id);
    const context = {
      available: true,
      repoRoot: "R:\\SGIT",
      worktreeRoot: "R:\\SGIT",
      gitCommonDir: "R:\\SGIT\\.git",
      isLinkedWorktree: false,
      branch: "ayanamislover/session-commands",
      head: "0123456789abcdef",
      detached: false,
      dirty: true,
      error: null,
    };
    const before = { row: sessionRow(), counts: mutationCounts(database) };
    database.sqlite.exec(`
      CREATE TRIGGER fail_git_context_outbox
      BEFORE INSERT ON outbox
      WHEN NEW.payload_json LIKE '%agent.git_context.updated%'
      BEGIN
        SELECT RAISE(ABORT, 'injected git context outbox failure');
      END;
    `);

    expect(() => repository.updateSessionGitContext(session.id, context)).toThrow(
      "injected git context outbox failure",
    );
    expect({ row: sessionRow(), counts: mutationCounts(database) }).toEqual(before);

    database.sqlite.exec("DROP TRIGGER fail_git_context_outbox");
    expect(repository.updateSessionGitContext(session.id, context)).toMatchObject({
      updated: true,
    });
    const afterUpdate = { row: sessionRow(), counts: mutationCounts(database) };
    expect(repository.updateSessionGitContext(session.id, context)).toEqual({
      updated: false,
      sequence: afterUpdate.counts.sequence,
    });
    expect({ row: sessionRow(), counts: mutationCounts(database) }).toEqual(afterUpdate);
  });

  it("rolls back Session close, claim release and lifecycle timestamp on outbox failure", async () => {
    const { database, repository } = await fixture("SCLOSE");
    const session = repository.createSession(sessionInput("SCLOSE"));
    const actor = { type: "AGENT" as const, id: "sclose-agent", sessionId: session.id };
    const objective = repository.createObjective(actor, {
      title: "Session close atomicity",
      description: "",
      definitionOfDone: [],
    });
    const created = repository.createWorkItems(actor, "session-close-task", [
      {
        clientRef: "claimed",
        objectiveId: objective.id,
        title: "Claimed task",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
      },
    ]).items[0]!;
    repository.patchWorkItems(actor, "session-close-claim", [
      { taskKey: created.key, expectedVersion: created.version, operation: "claim" },
    ]);
    const state = () => ({
      session: database.sqlite
        .prepare(
          `SELECT connection_state, work_state, closed_at, retirement_reason, close_reason, version
           FROM agent_sessions WHERE id = ?`,
        )
        .get(session.id),
      task: database.sqlite
        .prepare(
          `SELECT status, phase, assignee_agent_id, claimed_by_session_id, version,
                  last_session_closed_at
           FROM work_items WHERE local_no = ?`,
        )
        .get(created.localNo),
      counts: mutationCounts(database),
    });
    const before = state();
    database.sqlite.exec(`
      CREATE TRIGGER fail_force_close_outbox
      BEFORE INSERT ON outbox
      WHEN NEW.payload_json LIKE '%agent.force_closed%'
      BEGIN
        SELECT RAISE(ABORT, 'injected force close outbox failure');
      END;
    `);

    expect(() => repository.forceCloseSession(session.id, true)).toThrow(
      "injected force close outbox failure",
    );
    expect(state()).toEqual(before);

    database.sqlite.exec("DROP TRIGGER fail_force_close_outbox");
    repository.forceCloseSession(session.id, true);
    expect(state()).toMatchObject({
      session: { connection_state: "CLOSED", close_reason: "FORCE_CLOSE" },
      task: { status: "READY", claimed_by_session_id: null },
    });
  });
});

describe("Session command facade and module boundary", () => {
  it("preserves public prototype methods and nested create/get Session observation", async () => {
    for (const method of [
      "createSession",
      "recoverOrCreateSession",
      "resolveMutationActor",
      "executeSessionMutation",
      "updateSessionGitContext",
      "recoverStaleSessions",
      "forceCloseSession",
      "endSession",
    ]) {
      expect(Object.getOwnPropertyDescriptor(ProjectRepository.prototype, method)?.value).toEqual(
        expect.any(Function),
      );
    }

    const { repository } = await fixture("SFACE");
    const createSpy = vi.spyOn(repository, "createSession");
    const request = { agentId: "sface-agent", role: "SUBAGENT" };
    const input = sessionInput("SFACE");
    const first = repository.recoverOrCreateSession("session-facade-op", request, input);
    expect(first.disposition).toBe("CREATED");
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(repository.recoverOrCreateSession("session-facade-op", request, input)).toMatchObject({
      id: first.id,
      disposition: "RECOVERED",
    });
    expect(createSpy).toHaveBeenCalledTimes(1);

    const getSpy = vi.spyOn(repository, "getSession");
    expect(
      repository.resolveMutationActor(first.id, "new-operation", "work.patch", {}),
    ).toMatchObject({ disposition: "CURRENT", actor: { sessionId: first.id } });
    expect(getSpy).toHaveBeenCalledWith(first.id);
  });

  it("keeps command modules facade-free and injects the independent request normalizer leaf", () => {
    const repositorySource = readFileSync(
      resolve(process.cwd(), "packages/storage-sqlite/src/project-repository.ts"),
      "utf8",
    );
    expect(repositorySource).toMatch(/requestNormalizer:\s*this\.#requestNormalizer/u);
    for (const file of ["mutation-request-normalizer.ts", "session-commands.ts"]) {
      const source = readFileSync(
        resolve(process.cwd(), "packages/storage-sqlite/src", file),
        "utf8",
      );
      expect(source).not.toMatch(/from\s+["']\.\/(?:index|manager|project-repository)\.js["']/u);
    }
    const commands = readFileSync(
      resolve(process.cwd(), "packages/storage-sqlite/src/session-commands.ts"),
      "utf8",
    );
    expect(commands).toMatch(/requestNormalizer:\s*MutationRequestNormalizer/u);
    expect(commands).not.toMatch(/#sqlite\.transaction/u);
  });
});
