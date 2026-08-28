import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectRepository } from "@ayanami-task/storage-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function openService(prefix: string) {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dataDir);
  return AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
}

function createGitRepository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(root);
  const sourcePath = join(root, "source");
  mkdirSync(sourcePath, { recursive: true });
  writeFileSync(join(sourcePath, "tracked.ts"), "export const baseline = true;\n", "utf8");
  for (const args of [
    ["init"],
    ["config", "user.email", "atm@example.test"],
    ["config", "user.name", "ATM Test"],
    ["add", "tracked.ts"],
    ["commit", "-m", "baseline"],
  ]) {
    execFileSync("git", args, { cwd: sourcePath, stdio: "ignore", windowsHide: true });
  }
  return sourcePath;
}

describe("Application command coordination", () => {
  it("keeps an authoritative mutation when dispatch rejects and emits no projection events", async () => {
    const service = await openService("atm-command-hard-dispatch-");
    try {
      const project = await service.createProject({
        name: "Hard dispatch",
        sourcePath: null,
        code: "HDSP",
      });
      let projectEvents = 0;
      let globalEvents = 0;
      service.subscribeProject(project.code, () => {
        projectEvents += 1;
      });
      service.subscribeGlobal(() => {
        globalEvents += 1;
      });
      vi.spyOn(service.databases, "dispatchProject").mockRejectedValueOnce(
        new Error("injected hard dispatch rejection"),
      );

      await expect(
        service.createObjectiveAsUser(project.code, "hard-dispatch", {
          title: "Authoritative objective",
          description: "The project mutation commits before projection.",
          definitionOfDone: [],
        }),
      ).rejects.toThrow("injected hard dispatch rejection");

      const repository = new ProjectRepository(await service.databases.openProject(project.code));
      expect(repository.listObjectives()).toEqual([
        expect.objectContaining({ title: "Authoritative objective" }),
      ]);
      expect({ projectEvents, globalEvents }).toEqual({ projectEvents: 0, globalEvents: 0 });
    } finally {
      service.close();
    }
  });

  it("runs fail-open engineering metrics after exactly one successful projection flush", async () => {
    const sourcePath = createGitRepository("atm-command-metrics-");
    const service = await openService("atm-command-metrics-data-");
    try {
      const project = await service.createProject({
        name: "Metrics ordering",
        sourcePath,
        code: "MORD",
      });
      const objective = await service.createObjectiveAsUser(project.code, "objective", {
        title: "Ordering objective",
        description: "",
        definitionOfDone: [],
      });
      const task = (
        await service.createWorkItemsAsUser(project.code, "task", [
          {
            clientRef: "ordering",
            objectiveId: objective.id,
            title: "Capture ordering",
            description: "",
            type: "TASK",
            priority: "NORMAL",
            status: "READY",
            acceptance: [],
            checklist: [],
            verificationRequired: false,
          },
        ])
      ).items[0]!;
      const order: string[] = [];
      const dispatch = service.databases.dispatchProject.bind(service.databases);
      const dispatchSpy = vi
        .spyOn(service.databases, "dispatchProject")
        .mockImplementation(async (...args) => {
          order.push("flush");
          return dispatch(...args);
        });
      vi.spyOn(service.databases, "ensureWorkItemEngineeringBaseline").mockImplementation(
        async () => {
          order.push("metrics");
          throw new Error("injected metrics failure");
        },
      );

      await expect(
        service.patchWorkItemsAsUser(project.code, "start", [
          { taskKey: task.key, expectedVersion: task.version, operation: "start" },
        ]),
      ).resolves.toMatchObject({ items: [expect.objectContaining({ status: "IN_PROGRESS" })] });
      expect(order).toEqual(["flush", "metrics"]);
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
    } finally {
      service.close();
    }
  });

  it("preserves Agent/User receipt differences and flushes once per mutation", async () => {
    const service = await openService("atm-command-receipts-");
    try {
      const project = await service.createProject({
        name: "Receipt parity",
        sourcePath: null,
        code: "RCPT",
      });
      const objective = await service.createObjectiveAsUser(project.code, "objective", {
        title: "Receipt objective",
        description: "",
        definitionOfDone: [],
      });
      const begun = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "receipt-agent",
      });
      const dispatchSpy = vi.spyOn(service.databases, "dispatchProject");

      const agentReceipt = await service.createWorkItems(
        project.code,
        String(begun.session),
        "agent-create",
        [
          {
            clientRef: "agent",
            objectiveId: objective.id,
            title: "Agent item",
            type: "TASK",
            priority: "NORMAL",
            status: "READY",
          },
        ],
      );
      expect(agentReceipt).toMatchObject({
        opId: "agent-create",
        projection: { status: "APPLIED" },
      });
      expect(agentReceipt).not.toHaveProperty("sessionRebound");
      expect(dispatchSpy).toHaveBeenCalledTimes(1);

      dispatchSpy.mockClear();
      const userReceipt = await service.createWorkItemsAsUser(project.code, "user-create", [
        {
          clientRef: "user",
          objectiveId: objective.id,
          title: "User item",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
        },
      ]);
      expect(userReceipt).toMatchObject({ projection: { status: "APPLIED" } });
      expect(userReceipt).not.toHaveProperty("opId");
      expect(userReceipt).not.toHaveProperty("sessionRebound");
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
    } finally {
      service.close();
    }
  });

  it("skips Git refresh without cwd and on REPLAY, and targets the REBOUND successor", async () => {
    const sourcePath = createGitRepository("atm-command-git-");
    const reboundSourcePath = createGitRepository("atm-command-git-rebound-");
    const service = await openService("atm-command-git-data-");
    try {
      await service.createProject({ name: "No cwd", sourcePath: null, code: "NCWD" });
      const noCwd = await service.begin({
        projectCode: "NCWD",
        mode: "project",
        agentId: "no-cwd",
      });
      const updateGit = vi.spyOn(ProjectRepository.prototype, "updateSessionGitContext");
      await service.refreshSessionGitContextAsUser("NCWD", String(noCwd.session));
      expect(updateGit).not.toHaveBeenCalled();

      await service.createProject({ name: "Git replay", sourcePath, code: "GRPL" });
      const replay = await service.begin({
        projectCode: "GRPL",
        mode: "project",
        agentId: "replay-agent",
        cwd: sourcePath,
      });
      const endInput = {
        outcome: "retired" as const,
        summary: "Rotate",
        next: ["Continue"],
        releaseClaims: true,
        retirementReason: "test",
      };
      updateGit.mockClear();
      await service.end("GRPL", String(replay.session), "end-replay", endInput);
      expect(updateGit).toHaveBeenCalledTimes(1);
      await service.end("GRPL", String(replay.session), "end-replay", endInput);
      expect(updateGit).toHaveBeenCalledTimes(1);

      await service.createProject({
        name: "Git rebound",
        sourcePath: reboundSourcePath,
        code: "GRBD",
      });
      const stale = await service.begin({
        projectCode: "GRBD",
        mode: "project",
        agentId: "rebound-agent",
        cwd: reboundSourcePath,
      });
      const repository = new ProjectRepository(await service.databases.openProject("GRBD"));
      repository.recoverStaleSessions("2999-01-01T00:00:00.000Z");
      updateGit.mockClear();
      const rebound = await service.addProjectProgress(
        "GRBD",
        String(stale.session),
        "rebound-progress",
        { summary: "Refresh the successor Git context" },
      );
      expect(rebound).toMatchObject({ sessionRebound: true, newSession: expect.any(String) });
      expect(updateGit).toHaveBeenCalledTimes(1);
      expect(updateGit.mock.calls[0]?.[0]).toBe(rebound.newSession);
      expect(updateGit.mock.calls[0]?.[0]).not.toBe(stale.session);
    } finally {
      service.close();
    }
  });
});
