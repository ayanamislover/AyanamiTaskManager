import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function trashedScenario() {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-trashed-begin-"));
  const sourcePath = mkdtempSync(join(tmpdir(), "atm-trashed-source-"));
  temporary.push(dataDir, sourcePath);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await service.createProject({
    name: "垃圾箱绑定项目",
    sourcePath,
    code: "TRSH",
  });
  await service.trashProject(project.code);
  const begin = (agentId = "trashed-begin-agent") =>
    service.begin({ cwd: sourcePath, mode: "auto", agentId, allowProjectCreate: true });
  const failure = (agentId?: string) =>
    begin(agentId).then(
      () => {
        throw new Error("begin 不应成功");
      },
      (error: { details: Record<string, any> }) => error,
    );
  return { service, project, sourcePath, begin, failure };
}

function restoreEvents(service: AyanamiTaskService, type: string): number {
  return (
    service.databases.registry.sqlite
      .prepare("SELECT count(*) AS count FROM global_events WHERE type = ?")
      .get(type) as { count: number }
  ).count;
}

describe("垃圾箱项目的 begin 生命周期边界", () => {
  it.each([
    ["project", (code: string, _cwd: string) => ({ projectCode: code, mode: "project" as const })],
    ["auto", (_code: string, cwd: string) => ({ cwd, mode: "auto" as const })],
    ["quick", (code: string, _cwd: string) => ({ projectCode: code, mode: "quick" as const })],
  ])("%s 入口不恢复、不新建，登记待授权的恢复请求", async (_mode, input) => {
    const { service, project, sourcePath } = await trashedScenario();
    try {
      await expect(
        service.begin({
          ...input(project.code, sourcePath),
          agentId: "trashed-begin-agent",
          allowProjectCreate: true,
        }),
      ).rejects.toMatchObject({
        code: "PROJECT_DB_UNAVAILABLE",
        retryable: false,
        message: expect.stringContaining("ATM「项目 → 垃圾箱」"),
        details: {
          lifecycle: "TRASHED",
          project_code: "TRSH",
          project_id: project.id,
          recovery: {
            action: "await_user_restore_authorization",
            request_id: expect.any(String),
            request_count: 1,
          },
          quick: {
            matched_project: true,
            action: "do_not_bypass",
          },
        },
      });
      expect(service.databases.getProject(project.id).lifecycle).toBe("TRASHED");
      expect(service.listQuickTasks()).toHaveLength(0);
      expect(service.databases.listProjects(true)).toHaveLength(1);
      const [trashed] = service.listTrashedProjects();
      expect(trashed?.restoreRequest).toMatchObject({
        status: "PENDING",
        requestedBy: "trashed-begin-agent",
      });
    } finally {
      service.close();
    }
  });

  // ATM-T-0493：同一个 Agent 反复撞上来不该刷出一串待办。
  it("反复 begin 只挂一条请求，只记一次事件", async () => {
    const { service, failure } = await trashedScenario();
    try {
      const first = await failure();
      const second = await failure("another-agent");
      expect(second.details.recovery.request_id).toBe(first.details.recovery.request_id);
      expect(second.details.recovery.request_count).toBe(2);
      expect(restoreEvents(service, "project.restore_requested")).toBe(1);
      expect(service.listTrashedProjects()[0]?.restoreRequest).toMatchObject({
        requestCount: 2,
        requestedBy: "another-agent",
      });
    } finally {
      service.close();
    }
  });

  // ATM-T-0494：只有用户的决定能把项目拉回来。
  it("用户授权后项目恢复、请求记 APPROVED，Agent 重新 begin 成功", async () => {
    const { service, project, begin, failure } = await trashedScenario();
    try {
      const requestId = (await failure()).details.recovery.request_id as string;
      const decided = service.decideProjectRestoreRequest(requestId, "APPROVED");
      expect(decided.request).toMatchObject({ status: "APPROVED", decidedBy: "USER" });
      expect(decided.project.lifecycle).toBe("ACTIVE");
      expect(restoreEvents(service, "project.restore_approved")).toBe(1);
      expect(restoreEvents(service, "project.restored")).toBe(1);
      expect(service.listTrashedProjects()).toEqual([]);

      const session = await begin();
      expect(session).toMatchObject({ scope: "project" });
      expect(service.databases.listProjects(true).map((row) => row.id)).toEqual([project.id]);

      expect(() => service.decideProjectRestoreRequest(requestId, "REJECTED")).toThrow(
        expect.objectContaining({ code: "PROJECT_RESTORE_REQUEST_DECIDED" }),
      );
    } finally {
      service.close();
    }
  });

  it("用户拒绝后项目留在垃圾箱；Agent 再撞上来是一条新请求", async () => {
    const { service, project, failure } = await trashedScenario();
    try {
      const first = (await failure()).details.recovery.request_id as string;
      const decided = service.decideProjectRestoreRequest(first, "REJECTED");
      expect(decided.request.status).toBe("REJECTED");
      expect(decided.project.lifecycle).toBe("TRASHED");
      expect(service.databases.getProject(project.id).lifecycle).toBe("TRASHED");
      expect(service.listTrashedProjects()[0]?.restoreRequest).toBeNull();

      const second = (await failure()).details.recovery.request_id as string;
      expect(second).not.toBe(first);
      expect(service.listTrashedProjects()[0]?.restoreRequest?.id).toBe(second);
    } finally {
      service.close();
    }
  });

  it("用户直接点恢复项目时，挂着的请求一并记为 APPROVED", async () => {
    const { service, project, failure } = await trashedScenario();
    try {
      const requestId = (await failure()).details.recovery.request_id as string;
      service.restoreProject(project.code);
      expect(service.databases.getProject(project.id).lifecycle).toBe("ACTIVE");
      expect(() => service.decideProjectRestoreRequest(requestId, "APPROVED")).toThrow(
        expect.objectContaining({ code: "PROJECT_RESTORE_REQUEST_DECIDED" }),
      );
      expect(() =>
        service.databases.requestProjectRestore(project.id, {
          requestedBy: "late-agent",
          sourceCwd: null,
        }),
      ).toThrow(expect.objectContaining({ code: "PROJECT_LIFECYCLE_CONFLICT" }));
      expect(() => service.decideProjectRestoreRequest("missing-request", "APPROVED")).toThrow(
        expect.objectContaining({ code: "PROJECT_RESTORE_REQUEST_NOT_FOUND" }),
      );
    } finally {
      service.close();
    }
  });
});
