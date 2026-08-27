import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Registry 增量搜索投影", () => {
  it("任务编辑和多次进度只更新相关文档，不因重复任务键丢失摘要", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-incremental-projection-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "增量投影",
      sourcePath: null,
      code: "IPR",
    });
    const objective = await service.createObjectiveAsUser(project.code, "objective", {
      title: "验证投影",
      description: "",
      definitionOfDone: [],
    });
    const created = await service.createWorkItemsAsUser(project.code, "task", [
      {
        clientRef: "task",
        objectiveId: objective.id,
        title: "旧搜索标题",
        description: "",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
        acceptance: [],
        checklist: [],
        verificationRequired: false,
      },
    ]);
    const task = created.items[0]!;
    const begun = await service.begin({
      projectCode: project.code,
      mode: "project",
      agentId: "projection-agent",
      clientKind: "test",
    });
    await service.patchWorkItemsAsUser(project.code, "edit", [
      {
        taskKey: task.key,
        expectedVersion: task.version,
        operation: "edit",
        title: "新的中文搜索标题",
      },
    ]);
    await service.addProgress(project.code, String(begun.session), "progress-1", {
      taskKey: task.key,
      summary: "第一次进度摘要",
      completed: [],
      next: [],
      evidence: [],
      percent: 10,
    });
    await service.addProgress(project.code, String(begun.session), "progress-2", {
      taskKey: task.key,
      summary: "第二次进度摘要",
      completed: [],
      next: [],
      evidence: [],
      percent: 20,
    });

    expect(service.globalSearch("新的中文搜索标题").hits).toHaveLength(1);
    expect(service.globalSearch("第二次进度摘要").hits).toHaveLength(1);
    expect(
      service.overview().projects.find((entry: any) => entry.code === project.code)
        ?.project_sequence,
    ).toBeGreaterThanOrEqual(5);
    service.close();
  });
});
