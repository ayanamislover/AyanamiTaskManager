import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("milestone create validation", () => {
  it("validates inside the idempotent transaction action and leaves no failed operation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-milestone-create-validation-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await manager.createProject({
        name: "Milestone validation",
        sourcePath: null,
        code: "MVALID",
      });
      const repository = new ProjectRepository(await manager.openProject(project.code));
      const session = repository.createSession({
        agentId: "milestone-validation-agent",
        displayName: "Milestone Validation Agent",
        clientKind: "test",
        role: "PRIMARY",
      });
      const actor = {
        type: "AGENT" as const,
        id: "milestone-validation-agent",
        sessionId: session.id,
      };
      const objective = repository.createObjective(actor, {
        title: "Milestone validation",
        description: "",
        definitionOfDone: [],
      });
      const milestone = repository.createMilestone(actor, {
        objectiveId: objective.id,
        title: "Known milestone",
      });
      const missingMilestone = "00000000000000000000000000";
      const item = {
        clientRef: "task",
        objectiveId: objective.id,
        milestoneId: missingMilestone,
        title: "Must not persist",
        type: "TASK",
        priority: "NORMAL",
        status: "READY" as const,
      };

      expect(() => repository.createWorkItems(actor, "invalid-milestone", [item])).toThrowError(
        `MILESTONE_NOT_FOUND: ${missingMilestone}`,
      );
      expect(repository.listWorkItems({ limit: 100 })).toEqual([]);
      expect(() => repository.getOperationTrace("invalid-milestone", session.id)).toThrowError(
        "OPERATION_NOT_FOUND: invalid-milestone",
      );

      const committed = repository.createWorkItems(actor, "replay-priority", [
        { ...item, milestoneId: milestone.id, title: "Committed once" },
      ]);
      expect(committed.items).toHaveLength(1);
      expect(() =>
        repository.createWorkItems(actor, "replay-priority", [
          { ...item, clientRef: "changed-request" },
        ]),
      ).toThrowError(/IDEMPOTENCY_CONFLICT/u);
      expect(repository.listWorkItems({ limit: 100 })).toHaveLength(1);
    } finally {
      manager.close();
    }
  });
});
