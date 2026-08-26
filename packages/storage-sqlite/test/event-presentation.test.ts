import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";
import { presentEvent } from "../src/event-presentation.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("event presentation", () => {
  const project = { id: "project-1", code: "ATM", name: "AyanamiTaskManager" };

  it("turns task completion into a readable event while preserving identity", () => {
    const event = presentEvent({
      type: "work.completed",
      aggregateType: "WORK_ITEM",
      aggregateId: "work-1",
      actor: "codex-root",
      payload: { key: "ATM-T-0001", title: "交付验收", status: "DONE" },
      project,
    });

    expect(event).toMatchObject({
      type: "work.completed",
      key: "ATM-T-0001",
      actor: "codex-root",
      project,
    });
    expect(event.title).toContain("完成");
    expect(event.detail).toContain("交付验收");
  });

  it("explains progress, records, agent and git events instead of exposing raw event names", () => {
    expect(
      presentEvent({
        type: "work.progressed",
        aggregateType: "WORK_ITEM",
        aggregateId: "work-1",
        actor: "codex-root",
        payload: { key: "ATM-T-0001", summary: "完成后端", from: 30, to: 60 },
        project,
      }).detail,
    ).toContain("完成后端");

    expect(
      presentEvent({
        type: "record.created",
        aggregateType: "RECORD",
        aggregateId: "record-1",
        actor: "codex-root",
        payload: { key: "ATM-D-001", kind: "DECISION", title: "采用 SQLite", summary: "稳定优先" },
        project,
      }).title,
    ).toContain("决策");

    expect(
      presentEvent({
        type: "agent.git_context.updated",
        aggregateType: "SESSION",
        aggregateId: "session-1",
        actor: "SYSTEM",
        payload: { agentId: "codex-root", branch: "main", head: "abc1234", dirty: true },
        project,
      }).detail,
    ).toContain("main");
  });

  it("把批量 checklist 事件投影为含任务键与数量的可读时间线", () => {
    const event = presentEvent({
      type: "checklist.batch_updated",
      aggregateType: "WORK_ITEM",
      aggregateId: "work-1",
      actor: "codex-root",
      payload: {
        taskKey: "ATM-T-0111",
        items: [
          { checklistId: "one", status: "DONE" },
          { checklistId: "two", status: "DONE" },
        ],
      },
      project,
    });

    expect(event.title).toBe("批量更新验收清单");
    expect(event.detail).toContain("ATM-T-0111");
    expect(event.detail).toContain("2 项");
  });

  it("covers the lifecycle events used by task, project, agent and backup timelines", () => {
    const cases = [
      ["work.created", "创建任务", { key: "ATM-T-0002", title: "新任务" }],
      ["work.started", "开始任务", { key: "ATM-T-0002", title: "新任务" }],
      ["work.completed", "完成任务", { key: "ATM-T-0002", title: "新任务" }],
      ["project.creating", "开始创建项目", { name: "新项目" }],
      ["project.update.published", "发布项目摘要", { summary: "本轮已验收" }],
      ["agent.joined", "Agent 加入", { agentId: "luna", role: "SUBAGENT" }],
      ["agent.left", "Agent 离开", { agentId: "luna", summary: "完成" }],
      ["backup.created", "创建备份", { reason: "MANUAL", scope: "PROJECT" }],
      ["backup.failed", "备份失败", { reason: "DAILY", code: "IO_ERROR" }],
    ] as const;
    for (const [type, title, payload] of cases) {
      const event = presentEvent({
        type,
        aggregateType: "PROJECT",
        aggregateId: "aggregate-1",
        actor: "tester",
        payload,
        project,
      });
      expect(event.title).toContain(title);
      expect(event.detail.length).toBeGreaterThan(0);
      expect(event.project?.code).toBe("ATM");
    }
  });

  it("projects actual project events globally without summary-update noise", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-event-presentation-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const created = await manager.createProject({ name: "事件语义测试", sourcePath: null });
      const repository = new ProjectRepository(await manager.openProject(created.id));
      const actor = { type: "AGENT" as const, id: "event-test", sessionId: null };
      const objective = repository.createObjective(actor, {
        title: "测试目标",
        description: "",
        definitionOfDone: [],
      });
      repository.createWorkItems(actor, "event-work", [
        {
          clientRef: "event-task",
          objectiveId: objective.id,
          title: "投影一条可读事件",
          description: "",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
        },
      ]);

      const delivered = await manager.dispatchProject(created.id);
      expect(delivered.delivered).toBeGreaterThan(0);
      const overview = manager.overview() as { recentEvents: Array<Record<string, unknown>> };
      expect(overview.recentEvents.some((event) => event.type === "project.summary.updated")).toBe(
        false,
      );
      const projected = overview.recentEvents.find((event) => event.type === "work.created");
      expect(projected).toMatchObject({
        title: expect.stringContaining("创建"),
        detail: expect.stringContaining("投影一条可读事件"),
      });
      expect((projected?.project as Record<string, unknown>)?.code).toBe(created.code);
      expect(
        manager.globalDelta(0, 100).events.some((event) => event.type === "work.created"),
      ).toBe(true);
      const beforeSecondDispatch = Number((manager.overview() as { sequence: number }).sequence);
      expect((await manager.dispatchProject(created.id)).delivered).toBe(0);
      expect(Number((manager.overview() as { sequence: number }).sequence)).toBe(
        beforeSecondDispatch,
      );
    } finally {
      manager.close();
    }
  });
});
