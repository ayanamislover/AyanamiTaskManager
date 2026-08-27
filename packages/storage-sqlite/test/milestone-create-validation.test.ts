import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";
import { captureAtmError } from "./typed-error-test-helpers.js";

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

      expect(
        captureAtmError(() => repository.createWorkItems(actor, "invalid-milestone", [item])),
      ).toMatchObject({
        code: "MILESTONE_NOT_FOUND",
        details: { entity: "MILESTONE", reference: missingMilestone },
      });
      expect(repository.listWorkItems({ limit: 100 })).toEqual([]);
      expect(
        captureAtmError(() => repository.getOperationTrace("invalid-milestone", session.id)),
      ).toMatchObject({
        code: "OPERATION_NOT_FOUND",
        details: { entity: "OPERATION", reference: "invalid-milestone" },
      });

      const committed = repository.createWorkItems(actor, "replay-priority", [
        { ...item, milestoneId: milestone.id, title: "Committed once" },
      ]);
      expect(committed.items).toHaveLength(1);
      expect(
        captureAtmError(() =>
          repository.createWorkItems(actor, "replay-priority", [
            { ...item, clientRef: "changed-request" },
          ]),
        ),
      ).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", details: { key: expect.any(String) } });
      expect(repository.listWorkItems({ limit: 100 })).toHaveLength(1);
    } finally {
      manager.close();
    }
  });
});
