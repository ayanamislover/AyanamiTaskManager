import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("dynamic NOT_FOUND application semantics", () => {
  it("replays a committed create before milestone revalidation and preserves closed-Session priority", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-application-not-found-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({
        name: "NOT_FOUND application",
        sourcePath: null,
        code: "NFAPP",
      });
      const begun = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "not-found-application-agent",
        clientKind: "test",
      });
      const session = String(begun.session);
      const objective = await service.createObjectiveAsUser(project.code, "candidate-objective", {
        title: "Candidate objective",
        description: "",
        definitionOfDone: [],
      });
      const milestone = await service.createMilestoneAsUser(project.code, "candidate-milestone", {
        objectiveId: objective.id,
        title: "Candidate milestone",
      });
      const items = [
        {
          clientRef: "task",
          objectiveId: objective.id,
          milestoneId: milestone.id,
          title: "Committed task",
          type: "TASK",
          priority: "NORMAL",
          status: "READY" as const,
        },
      ];
      const committed = await service.createWorkItems(
        project.code,
        session,
        "committed-before-close",
        items,
      );
      await service.end(project.code, session, "close-after-create", {
        outcome: "completed",
        summary: "Close after a committed create",
        next: [],
        releaseClaims: true,
      });

      const replayed = await service.createWorkItems(
        project.code,
        session,
        "committed-before-close",
        items,
      );
      expect(replayed.items[0]!.key).toBe(committed.items[0]!.key);
      await expect(
        service.createWorkItems(project.code, session, "committed-before-close", [
          {
            ...items[0]!,
            clientRef: "changed",
            milestoneId: "00000000000000000000000000",
          },
        ]),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        details: { session_id: session, operation_id: "committed-before-close" },
      });
      await expect(
        service.createWorkItems(project.code, session, "closed-new-invalid", [
          { ...items[0]!, milestoneId: "00000000000000000000000000" },
        ]),
      ).rejects.toMatchObject({
        code: "SESSION_CLOSED",
        details: { entity: "SESSION", reference: session },
      });
      expect(await service.listWorkItems(project.code, { limit: 100 })).toHaveLength(1);
      await expect(
        service.getOperationTrace(project.code, "closed-new-invalid", session),
      ).rejects.toMatchObject({
        code: "OPERATION_NOT_FOUND",
        details: { entity: "OPERATION", reference: "closed-new-invalid" },
      });
    } finally {
      service.close();
    }
  });
});
