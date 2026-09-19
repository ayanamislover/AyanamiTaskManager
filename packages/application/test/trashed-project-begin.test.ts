import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("垃圾箱项目的 begin 生命周期边界", () => {
  it.each([
    ["project", (code: string, _cwd: string) => ({ projectCode: code, mode: "project" as const })],
    ["auto", (_code: string, cwd: string) => ({ cwd, mode: "auto" as const })],
    ["quick", (code: string, _cwd: string) => ({ projectCode: code, mode: "quick" as const })],
  ])("%s 入口返回不可盲重试的可行动诊断且不创建任务", async (_mode, input) => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-trashed-begin-"));
    const sourcePath = mkdtempSync(join(tmpdir(), "atm-trashed-source-"));
    temporary.push(dataDir, sourcePath);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({
        name: "垃圾箱绑定项目",
        sourcePath,
        code: "TRSH",
      });
      await service.trashProject(project.code);

      await expect(
        service.begin({
          ...input(project.code, sourcePath),
          agentId: "trashed-begin-agent",
          allowProjectCreate: true,
        }),
      ).rejects.toMatchObject({
        code: "PROJECT_DB_UNAVAILABLE",
        retryable: false,
        message: expect.stringContaining("TRSH"),
        details: {
          lifecycle: "TRASHED",
          project_code: "TRSH",
          project_id: project.id,
          recovery: {
            action: "restore_project",
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
    } finally {
      service.close();
    }
  });
});
