import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];

function spawnBeginWorker(input: {
  dataDir: string;
  migrationsRoot: string;
  projectCode: string;
  workspaceRoot: string;
  operationId: string;
  readyPath: string;
  goPath: string;
}) {
  const executable = process.execPath;
  const tsxCli = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const fixture = resolve(
    process.cwd(),
    "packages/application/test/fixtures/session-begin-worker.ts",
  );
  const child = spawn(
    executable,
    [
      tsxCli,
      fixture,
      input.dataDir,
      input.migrationsRoot,
      input.projectCode,
      input.workspaceRoot,
      input.operationId,
      input.readyPath,
      input.goPath,
    ],
    { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<Record<string, unknown>>((resolveCompletion, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`session begin worker exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolveCompletion(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        reject(new Error(`session begin worker returned malformed output: ${stdout}`));
      }
    });
  });
  return { child, completion };
}

async function waitForFiles(paths: string[], timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (paths.some((path) => !existsSync(path))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${paths.join(", ")}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("atomic Session recover-or-begin", () => {
  it("returns one durable Session for concurrent and cold retries of the same operation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-session-begin-idempotency-"));
    temporary.push(dataDir);
    const migrationsRoot = resolve(process.cwd(), "migrations");
    const workspaceRoot = resolve(dataDir, "workspace");
    mkdirSync(workspaceRoot);

    const bootstrap = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    let project: Awaited<ReturnType<typeof bootstrap.createProject>>;
    try {
      project = await bootstrap.createProject({
        name: "Atomic begin",
        sourcePath: workspaceRoot,
        code: "ABEGIN",
      });
    } finally {
      bootstrap.close();
    }

    const left = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    const right = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    const request = {
      operationId: " session-begin-same-request ",
      projectCode: project.code,
      cwd: workspaceRoot,
      mode: "project" as const,
      agentId: "codex-primary",
      displayName: "Codex primary",
      clientKind: "codex-desktop",
      threadId: "thr_exact",
      parentSessionId: null,
      role: "PRIMARY" as const,
      resume: false,
      maxChars: 1200,
    };
    let createdSession = "";

    try {
      const [first, duplicate] = await Promise.all([left.begin(request), right.begin(request)]);
      expect(first.session).toBe(duplicate.session);
      expect([first.atomicBegin.disposition, duplicate.atomicBegin.disposition].sort()).toEqual([
        "CREATED",
        "RECOVERED",
      ]);
      expect(first.atomicBegin.operationId).toBe(request.operationId.trim());
      expect(duplicate.atomicBegin.operationId).toBe(request.operationId.trim());
      createdSession = String(first.session);
      expect(await left.listAgentSessions(project.code)).toHaveLength(1);

      await expect(
        right.begin({
          ...request,
          threadId: "thr_different",
        }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        details: {
          key: `session-begin:${request.operationId.trim()}`,
        },
      });
    } finally {
      left.close();
      right.close();
    }

    const cold = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    try {
      const replay = await cold.begin({
        ...request,
        operationId: request.operationId.trim(),
      });
      expect(await cold.listAgentSessions(project.code)).toHaveLength(1);
      expect(replay.session).toBe(createdSession);
      expect(replay.atomicBegin).toEqual({
        operationId: request.operationId.trim(),
        disposition: "RECOVERED",
      });
    } finally {
      cold.close();
    }
  });

  it("fails before creating quick or project state when the atomic project does not exist", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-session-begin-project-scope-"));
    temporary.push(dataDir);
    const migrationsRoot = resolve(process.cwd(), "migrations");
    const unmatchedRoot = resolve(dataDir, "unmatched-workspace");
    mkdirSync(unmatchedRoot);
    const service = await AyanamiTaskService.open({ dataDir, migrationsRoot });

    try {
      await expect(
        service.begin({
          operationId: "session-begin-requires-project",
          cwd: unmatchedRoot,
          mode: "quick",
          agentId: "codex-primary",
        }),
      ).rejects.toMatchObject({
        code: "ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT",
        details: null,
      });
      expect(service.listQuickTasks()).toHaveLength(0);
      expect(service.listProjects()).toHaveLength(0);

      await expect(
        service.begin({
          operationId: "session-begin-cannot-create-project",
          cwd: unmatchedRoot,
          mode: "project",
          agentId: "codex-primary",
          allowProjectCreate: true,
        }),
      ).rejects.toMatchObject({
        code: "ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT",
        details: null,
      });
      expect(service.listProjects()).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  it("rolls back Session, event, outbox, and idempotency state when publication fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-session-begin-rollback-"));
    temporary.push(dataDir);
    const migrationsRoot = resolve(process.cwd(), "migrations");
    const workspaceRoot = resolve(dataDir, "workspace");
    mkdirSync(workspaceRoot);
    const service = await AyanamiTaskService.open({ dataDir, migrationsRoot });

    try {
      const project = await service.createProject({
        name: "Atomic begin rollback",
        sourcePath: workspaceRoot,
        code: "ABROLL",
      });
      const database = await service.databases.openProject(project.code);
      const beforeEvents = Number(
        (database.sqlite.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number })
          .count,
      );
      const beforeOutbox = Number(
        (database.sqlite.prepare("SELECT COUNT(*) AS count FROM outbox").get() as { count: number })
          .count,
      );
      database.sqlite.exec(`
        CREATE TRIGGER reject_session_begin_idempotency
        BEFORE INSERT ON idempotency_keys
        WHEN NEW.key = 'session-begin:session-begin-rollback'
        BEGIN
          SELECT RAISE(ABORT, 'injected idempotency publication failure');
        END;
      `);

      const request = {
        operationId: "session-begin-rollback",
        projectCode: project.code,
        cwd: workspaceRoot,
        mode: "project" as const,
        agentId: "codex-rollback",
      };
      await expect(service.begin(request)).rejects.toThrow(/idempotency publication failure/i);
      expect(await service.listAgentSessions(project.code)).toHaveLength(0);
      expect(
        (database.sqlite.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number })
          .count,
      ).toBe(beforeEvents);
      expect(
        (database.sqlite.prepare("SELECT COUNT(*) AS count FROM outbox").get() as { count: number })
          .count,
      ).toBe(beforeOutbox);
      expect(
        (
          database.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get() as {
            count: number;
          }
        ).count,
      ).toBe(0);

      database.sqlite.exec("DROP TRIGGER reject_session_begin_idempotency");
      await expect(service.begin(request)).resolves.toMatchObject({ scope: "project" });
      expect(await service.listAgentSessions(project.code)).toHaveLength(1);
    } finally {
      service.close();
    }
  });

  it("serializes two OS processes onto one durable Session", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-session-begin-processes-"));
    temporary.push(dataDir);
    const migrationsRoot = resolve(process.cwd(), "migrations");
    const workspaceRoot = resolve(dataDir, "workspace");
    const readyLeft = resolve(dataDir, "left.ready");
    const readyRight = resolve(dataDir, "right.ready");
    const goPath = resolve(dataDir, "go.signal");
    mkdirSync(workspaceRoot);
    const bootstrap = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    try {
      await bootstrap.createProject({
        name: "Atomic begin processes",
        sourcePath: workspaceRoot,
        code: "ABPROC",
      });
    } finally {
      bootstrap.close();
    }

    const common = {
      dataDir,
      migrationsRoot,
      projectCode: "ABPROC",
      workspaceRoot,
      operationId: "session-begin-process-race",
      goPath,
    };
    const left = spawnBeginWorker({ ...common, readyPath: readyLeft });
    const right = spawnBeginWorker({ ...common, readyPath: readyRight });
    try {
      await waitForFiles([readyLeft, readyRight]);
      writeFileSync(goPath, "go", "utf8");
      const [first, duplicate] = await Promise.all([left.completion, right.completion]);
      expect(first.session).toBe(duplicate.session);
      expect([first.disposition, duplicate.disposition].sort()).toEqual(["CREATED", "RECOVERED"]);

      const verifier = await AyanamiTaskService.open({ dataDir, migrationsRoot });
      try {
        expect(await verifier.listAgentSessions("ABPROC")).toHaveLength(1);
        const database = await verifier.databases.openProject("ABPROC");
        expect(
          (
            database.sqlite
              .prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'agent.joined'")
              .get() as { count: number }
          ).count,
        ).toBe(1);
        expect(
          (
            database.sqlite
              .prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = ?")
              .get("session-begin:session-begin-process-race") as { count: number }
          ).count,
        ).toBe(1);
        expect(
          (
            database.sqlite.prepare("SELECT COUNT(*) AS count FROM outbox").get() as {
              count: number;
            }
          ).count,
        ).toBe(1);
      } finally {
        verifier.close();
      }
    } finally {
      for (const worker of [left.child, right.child]) {
        if (worker.exitCode === null) worker.kill();
      }
    }
  });

  it("does not bind the request fingerprint to newly observed Git state", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-session-begin-git-observation-"));
    temporary.push(dataDir);
    const migrationsRoot = resolve(process.cwd(), "migrations");
    const workspaceRoot = resolve(dataDir, "workspace");
    mkdirSync(workspaceRoot);
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: workspaceRoot,
        encoding: "utf8",
        windowsHide: true,
      }).trim();
    git(["init"]);
    git(["config", "user.email", "atm@example.test"]);
    git(["config", "user.name", "ATM Test"]);
    writeFileSync(resolve(workspaceRoot, "tracked.txt"), "clean\n", "utf8");
    git(["add", "tracked.txt"]);
    git(["commit", "-m", "baseline"]);

    const service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    try {
      const project = await service.createProject({
        name: "Atomic begin Git observation",
        sourcePath: workspaceRoot,
        code: "ABGIT",
      });
      const request = {
        operationId: "session-begin-git-observation",
        projectCode: project.code,
        cwd: workspaceRoot,
        mode: "project" as const,
        agentId: "codex-git-observation",
      };
      const first = await service.begin(request);
      writeFileSync(resolve(workspaceRoot, "tracked.txt"), "dirty\n", "utf8");
      const replay = await service.begin(request);
      expect(replay.session).toBe(first.session);
      expect(replay.atomicBegin).toEqual({
        operationId: request.operationId,
        disposition: "RECOVERED",
      });
      expect(await service.listAgentSessions(project.code)).toHaveLength(1);
    } finally {
      service.close();
    }
  });
});
