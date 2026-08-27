import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("exact entity service reads", () => {
  it("reads complete Progress and Session entities only from the requested project", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-service-exact-read-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "Exact read", sourcePath: null, code: "XREAD" });
      await service.createProject({ name: "Other project", sourcePath: null, code: "XOTHER" });
      const begun = await service.begin({
        projectCode: "XREAD",
        mode: "project",
        agentId: "service-exact-reader",
        clientKind: "test",
      });
      const sessionId = String(begun.session);
      const objective = await service.createObjectiveAsUser("XREAD", "exact-objective", {
        title: "Exact entities",
        description: "",
        definitionOfDone: [],
      });
      const created = await service.createWorkItemsAsUser("XREAD", "exact-task", [
        {
          clientRef: "task",
          objectiveId: objective.id,
          title: "Read the progress entity",
          description: "",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
          acceptance: [],
          checklist: [],
          verificationRequired: false,
        },
      ]);
      const taskKey = created.items[0]!.key;
      const progress = await service.addProgress("XREAD", sessionId, "service-progress", {
        taskKey,
        percent: 60,
        summary: "Service returns the complete stored entity.",
        completed: ["repository projection"],
        next: ["wire MCP later"],
        evidence: [{ kind: "atm_task", value: taskKey }],
      });

      await expect(service.getProgressUpdate("XREAD", progress.progressId)).resolves.toMatchObject({
        id: progress.progressId,
        taskKey,
        summary: "Service returns the complete stored entity.",
        sessionId,
        opId: "service-progress",
      });
      const session = await service.getSession("XREAD", sessionId);
      expect(session).toMatchObject({
        id: sessionId,
        agentId: "service-exact-reader",
        displayName: "service-exact-reader",
        clientKind: "test",
        role: "PRIMARY",
        connectionState: "ONLINE",
        git: {
          available: false,
          branch: null,
          head: null,
        },
      });
      expect(Object.keys(session).sort()).toEqual(
        [
          "id",
          "agentId",
          "displayName",
          "clientKind",
          "capabilities",
          "parentSessionId",
          "predecessorSessionId",
          "threadId",
          "role",
          "cwd",
          "workState",
          "connectionState",
          "currentTaskKey",
          "heartbeatAt",
          "version",
          "startedAt",
          "updatedAt",
          "closedAt",
          "retirementReason",
          "closeReason",
          "git",
        ].sort(),
      );
      expect(session).not.toHaveProperty("agent_id");
      expect(session).not.toHaveProperty("current_work_item_id");

      await expect(service.getProgressUpdate("XOTHER", progress.progressId)).rejects.toMatchObject({
        code: "PROGRESS_NOT_FOUND",
        details: { entity: "PROGRESS", reference: progress.progressId },
      });
      await expect(service.getSession("XOTHER", sessionId)).rejects.toMatchObject({
        code: "SESSION_NOT_FOUND",
        details: { entity: "SESSION", reference: sessionId },
      });
      await expect(
        service.getOperationTrace("XOTHER", "service-progress", sessionId),
      ).rejects.toMatchObject({
        code: "SESSION_NOT_FOUND",
        details: { entity: "SESSION", reference: sessionId },
      });
      await expect(
        service.getOperationTrace("XREAD", "missing-operation", sessionId),
      ).rejects.toMatchObject({
        code: "OPERATION_NOT_FOUND",
        details: { entity: "OPERATION", reference: "missing-operation" },
      });
      await expect(
        service.getProgressUpdate("XREAD", "01UNKNOWNPROGRESSULID0000000"),
      ).rejects.toMatchObject({
        code: "PROGRESS_NOT_FOUND",
        details: { entity: "PROGRESS", reference: "01UNKNOWNPROGRESSULID0000000" },
      });
      await expect(
        service.getSession("XREAD", "01UNKNOWNSESSIONULID00000000"),
      ).rejects.toMatchObject({
        code: "SESSION_NOT_FOUND",
        details: { entity: "SESSION", reference: "01UNKNOWNSESSIONULID00000000" },
      });
    } finally {
      service.close();
    }
  });
});
