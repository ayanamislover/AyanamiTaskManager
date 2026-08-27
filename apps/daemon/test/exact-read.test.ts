import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { buildAyanamiServer } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-daemon-exact-read-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await service.createProject({
    name: "REST exact reads",
    sourcePath: null,
    code: "XREST",
  });
  const begun = await service.begin({
    projectCode: project.code,
    mode: "project",
    agentId: "rest-exact-agent",
    displayName: "REST Exact Agent",
    clientKind: "test",
  });
  const objective = await service.createObjectiveAsUser(project.code, "rest-exact-objective", {
    title: "REST exact entities",
    description: "",
    definitionOfDone: [],
  });
  const created = await service.createWorkItemsAsUser(project.code, "rest-exact-task", [
    {
      clientRef: "task",
      objectiveId: objective.id,
      title: "Expose exact REST entities",
      type: "TASK",
      priority: "HIGH",
      status: "READY",
    },
  ]);
  const taskKey = created.items[0]!.key;
  const progress = await service.addProgress(
    project.code,
    String(begun.session),
    "rest-exact-progress",
    {
      taskKey,
      percent: 63,
      summary: "Return the complete Progress DTO.",
      completed: [{ text: "storage exact read", workItemKey: taskKey }],
      next: ["REST exact route"],
      evidence: [{ kind: "atm_task", value: taskKey }],
    },
  );
  const app = await buildAyanamiServer({ service, token: "local-secret" });
  return { app, service, project, begun, taskKey, progress };
}

describe("Progress and Session REST exact reads", () => {
  it("GETs one complete Progress by project and ULID", async () => {
    const { app, service, project, begun, taskKey, progress } = await fixture();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.code}/progress-updates/${progress.progressId}`,
        headers: { authorization: "Bearer local-secret" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id: progress.progressId,
        taskKey,
        percent: 63,
        progressBucket: 60,
        summary: "Return the complete Progress DTO.",
        completed: [{ text: "storage exact read", workItemKey: taskKey }],
        next: ["REST exact route"],
        blocker: null,
        actor: "rest-exact-agent",
        sessionId: begun.session,
        evidence: [{ kind: "atm_task", value: taskKey }],
        opId: "rest-exact-progress",
        createdAt: expect.any(String),
      });
    } finally {
      await app.close();
      service.close();
    }
  });

  it("GETs one bounded public Session by project and ULID", async () => {
    const { app, service, project, begun } = await fixture();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.code}/sessions/${begun.session}`,
        headers: { authorization: "Bearer local-secret" },
      });

      expect(response.statusCode).toBe(200);
      const session = response.json() as Record<string, unknown>;
      expect(session).toMatchObject({
        id: begun.session,
        agentId: "rest-exact-agent",
        displayName: "REST Exact Agent",
        clientKind: "test",
        role: "PRIMARY",
        connectionState: "ONLINE",
        currentTaskKey: null,
        git: {
          available: false,
          repoRoot: null,
          worktreeRoot: null,
          commonDir: null,
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
      expect(session).not.toHaveProperty("current_work_item_id");
      expect(session).not.toHaveProperty("capabilities_json");
    } finally {
      await app.close();
      service.close();
    }
  });

  it("returns typed 404s instead of reading an exact id from another project", async () => {
    const { app, service, project, begun, progress } = await fixture();
    try {
      const otherProject = await service.createProject({
        name: "Wrong REST exact-read project",
        sourcePath: null,
        code: "XRESTO",
      });
      const cases = [
        {
          url: `/api/v1/projects/${project.code}/progress-updates/00000000000000000000000000`,
          code: "PROGRESS_NOT_FOUND",
        },
        {
          url: `/api/v1/projects/${otherProject.code}/progress-updates/${progress.progressId}`,
          code: "PROGRESS_NOT_FOUND",
        },
        {
          url: `/api/v1/projects/${project.code}/sessions/00000000000000000000000000`,
          code: "SESSION_NOT_FOUND",
        },
        {
          url: `/api/v1/projects/${otherProject.code}/sessions/${begun.session}`,
          code: "SESSION_NOT_FOUND",
        },
      ];
      for (const testCase of cases) {
        const response = await app.inject({
          method: "GET",
          url: testCase.url,
          headers: { authorization: "Bearer local-secret" },
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: testCase.code } });
      }
    } finally {
      await app.close();
      service.close();
    }
  });
});
