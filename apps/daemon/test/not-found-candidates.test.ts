import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  const dataDir = mkdtempSync(join(tmpdir(), "atm-not-found-candidates-"));
  temporary.push(dataDir);
  const sourcePath = join(dataDir, "private-source-root");
  mkdirSync(sourcePath);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await service.createProject({
    name: "NOT_FOUND candidates",
    sourcePath,
    code: "NFSAFE",
  });
  const objective = await service.createObjectiveAsUser(project.code, "candidate-objective", {
    title: "Candidate objective",
    description: "",
    definitionOfDone: [],
  });
  const milestone = await service.createMilestoneAsUser(project.code, "candidate-milestone", {
    objectiveId: objective.id,
    title: `Candidate milestone ${sourcePath} local-secret`,
  });
  const milestones = [milestone];
  for (let index = 1; index < 7; index += 1) {
    milestones.push(
      await service.createMilestoneAsUser(project.code, `candidate-milestone-${index + 1}`, {
        objectiveId: objective.id,
        title: `Candidate milestone ${index + 1}`,
      }),
    );
  }
  const created = await service.createWorkItemsAsUser(
    project.code,
    "candidate-tasks",
    Array.from({ length: 7 }, (_, index) => ({
      clientRef: `task-${index + 1}`,
      objectiveId: objective.id,
      milestoneId: milestone.id,
      title:
        index === 0
          ? `Candidate task ${index + 1} ${sourcePath} local-secret`
          : `Candidate task ${index + 1}`,
      type: "TASK",
      priority: "NORMAL",
      status: "READY" as const,
    })),
  );
  const sessions = [];
  for (let index = 0; index < 7; index += 1) {
    sessions.push(
      await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: `candidate-agent-${index + 1}`,
        displayName:
          index === 0
            ? `Candidate Agent ${index + 1} ${sourcePath} local-secret`
            : `Candidate Agent ${index + 1}`,
        clientKind: "test",
      }),
    );
  }
  const app = await buildAyanamiServer({ service, token: "local-secret" });
  return { app, service, project, sourcePath, objective, milestone, milestones, created, sessions };
}

describe("dynamic NOT_FOUND candidates", () => {
  it("returns bounded stable task_key candidates to an authenticated REST caller", async () => {
    const { app, service, project, sourcePath, created } = await fixture();
    try {
      const missingKey = `${project.code}-T-000I`;
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.code}/work-items/${missingKey}`,
        headers: { authorization: "Bearer local-secret" },
      });
      const body = response.json() as {
        error: {
          code: string;
          details?: {
            entity?: string;
            did_you_mean?: string | null;
            candidates?: Array<Record<string, unknown>>;
          };
        };
      };

      expect(response.statusCode).toBe(404);
      expect(body.error.code).toBe("WORK_ITEM_NOT_FOUND");
      expect(body.error.details?.entity).toBe("WORK_ITEM");
      expect(body.error.details?.did_you_mean).toBe(created.items[0]!.key);
      expect(body.error.details?.candidates).toHaveLength(5);
      for (const candidate of body.error.details?.candidates ?? []) {
        expect(Object.keys(candidate).sort()).toEqual(["key", "status"]);
      }
      expect(JSON.stringify(body)).not.toContain(sourcePath);
      expect(JSON.stringify(body)).not.toContain(created.items[0]!.id);
      expect(JSON.stringify(body)).not.toContain("local-secret");
    } finally {
      await app.close();
      service.close();
    }
  });

  it("returns bounded stable Session candidates for a missing Session ULID", async () => {
    const { app, service, project, sourcePath, sessions } = await fixture();
    try {
      const expected = String(sessions[0]!.session);
      const missingId = `${expected.slice(0, -1)}${expected.endsWith("0") ? "1" : "0"}`;
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.code}/sessions/${missingId}`,
        headers: { authorization: "Bearer local-secret" },
      });
      const body = response.json() as {
        error: {
          code: string;
          details?: {
            entity?: string;
            did_you_mean?: string | null;
            candidates?: Array<Record<string, unknown>>;
          };
        };
      };

      expect(response.statusCode).toBe(404);
      expect(body.error.code).toBe("SESSION_NOT_FOUND");
      expect(body.error.details?.entity).toBe("SESSION");
      expect(body.error.details?.did_you_mean).toBe(expected);
      expect(body.error.details?.candidates).toHaveLength(5);
      for (const candidate of body.error.details?.candidates ?? []) {
        expect(Object.keys(candidate).sort()).toEqual(["connection_state", "id", "work_state"]);
      }
      expect(JSON.stringify(body)).not.toContain(sourcePath);
      expect(JSON.stringify(body)).not.toContain("local-secret");
    } finally {
      await app.close();
      service.close();
    }
  });

  it("rejects an unknown milestone_id filter with bounded stable milestone candidates", async () => {
    const { app, service, project, sourcePath, milestones } = await fixture();
    try {
      const expected = String(milestones[0]!.id);
      const missingId = `${expected.slice(0, -1)}${expected.endsWith("0") ? "1" : "0"}`;
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.code}/work-items?milestone=${missingId}`,
        headers: { authorization: "Bearer local-secret" },
      });
      const body = response.json() as {
        error: {
          code: string;
          details?: {
            entity?: string;
            did_you_mean?: string | null;
            candidates?: Array<Record<string, unknown>>;
          };
        };
      };

      expect(response.statusCode).toBe(404);
      expect(body.error.code).toBe("MILESTONE_NOT_FOUND");
      expect(body.error.details?.entity).toBe("MILESTONE");
      expect(body.error.details?.did_you_mean).toBe(expected);
      expect(body.error.details?.candidates).toHaveLength(5);
      for (const candidate of body.error.details?.candidates ?? []) {
        expect(Object.keys(candidate).sort()).toEqual(["id", "status"]);
      }
      expect(JSON.stringify(body)).not.toContain(sourcePath);
      expect(JSON.stringify(body)).not.toContain("local-secret");
    } finally {
      await app.close();
      service.close();
    }
  });

  it("never fuzzy-routes a milestone_id write and leaves no task or operation behind", async () => {
    const { app, service, project, objective, milestones, created, sessions } = await fixture();
    try {
      const expected = String(milestones[0]!.id);
      const missingId = `${expected.slice(0, -1)}${expected.endsWith("0") ? "1" : "0"}`;
      const opId = "missing-milestone-write";
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.code}/work-items`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: String(sessions[0]!.session),
          opId,
          items: [
            {
              clientRef: "must-not-create",
              objectiveId: objective.id,
              milestoneId: missingId,
              title: "Must not fuzzy route",
              type: "TASK",
              priority: "NORMAL",
              status: "READY",
            },
          ],
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: {
          code: "MILESTONE_NOT_FOUND",
          details: { entity: "MILESTONE", did_you_mean: expected },
        },
      });
      expect(await service.listWorkItems(project.code, { limit: 100 })).toHaveLength(
        created.items.length,
      );
      await expect(
        service.getOperationTrace(project.code, opId, String(sessions[0]!.session)),
      ).rejects.toMatchObject({
        code: "OPERATION_NOT_FOUND",
        details: { reference: opId },
      });

      const uiOpId = "ui-missing-milestone-write";
      const uiResponse = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.code}/ui/work-items`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          opId: uiOpId,
          items: [
            {
              clientRef: "ui-must-not-create",
              objectiveId: objective.id,
              milestoneId: missingId,
              title: "UI must not fuzzy route",
              type: "TASK",
              priority: "NORMAL",
              status: "READY",
            },
          ],
        },
      });
      expect(uiResponse.statusCode).toBe(404);
      expect(uiResponse.json()).toMatchObject({
        error: {
          code: "MILESTONE_NOT_FOUND",
          details: { entity: "MILESTONE", did_you_mean: expected },
        },
      });
      expect(await service.listWorkItems(project.code, { limit: 100 })).toHaveLength(
        created.items.length,
      );
      await expect(service.getOperationTrace(project.code, uiOpId)).rejects.toMatchObject({
        code: "OPERATION_NOT_FOUND",
        details: { reference: uiOpId },
      });
    } finally {
      await app.close();
      service.close();
    }
  });

  it("does not disclose dynamic candidates to an unauthenticated REST caller", async () => {
    const { app, service, project, sourcePath, created, milestones, sessions } = await fixture();
    try {
      const missingSession = `${String(sessions[0]!.session).slice(0, -1)}0`;
      const missingMilestone = `${String(milestones[0]!.id).slice(0, -1)}0`;
      const urls = [
        `/api/v1/projects/${project.code}/work-items/${project.code}-T-000I`,
        `/api/v1/projects/${project.code}/sessions/${missingSession}`,
        `/api/v1/projects/${project.code}/work-items?milestone=${missingMilestone}`,
      ];
      for (const url of urls) {
        const response = await app.inject({ method: "GET", url });
        const body = response.json();
        expect(response.statusCode).toBe(401);
        expect(body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
        expect(JSON.stringify(body)).not.toContain("candidates");
        expect(JSON.stringify(body)).not.toContain(sourcePath);
        expect(JSON.stringify(body)).not.toContain(created.items[0]!.id);
        expect(JSON.stringify(body)).not.toContain("local-secret");
      }
    } finally {
      await app.close();
      service.close();
    }
  });
});
