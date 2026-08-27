import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("项目更新", () => {
  it("生成确定性草稿、允许用户发布，并支持 Agent 的 project scope 进度", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-project-update-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "更新测试", sourcePath: null, code: "UPD" });
      const draft = await service.draftProjectUpdateAsUser("UPD", "draft-1");
      expect(draft).toMatchObject({
        status: "DRAFT",
        summary: expect.any(String),
        completed: [],
        risks: [],
      });
      const published = await service.publishProjectUpdateAsUser("UPD", "publish-1", {
        draftId: draft.id,
        health: "ON_TRACK",
        summary: "存储链路稳定",
        completed: ["在线备份"],
        risks: [],
        next: ["打包烟测"],
      });
      expect(published).toMatchObject({
        status: "PUBLISHED",
        health: "ON_TRACK",
        summary: "存储链路稳定",
      });

      const begun = await service.begin({
        projectCode: "UPD",
        mode: "project",
        agentId: "agent-update",
        clientKind: "test",
      });
      const objective = await service.createObjectiveAsUser("UPD", "objective-unlinked", {
        title: "任务图关联",
        description: "",
        definitionOfDone: [],
      });
      const open = await service.createWorkItemsAsUser("UPD", "task-unlinked", [
        {
          clientRef: "open",
          objectiveId: objective.id,
          title: "仍需更新的任务",
          description: "",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          acceptance: [],
          checklist: [],
          verificationRequired: false,
        },
      ]);
      const fromAgent = await service.addProjectProgress(
        "UPD",
        String(begun.session),
        "agent-update-1",
        {
          health: "AT_RISK",
          summary: "等待原生模块烟测",
          completed: ["编译"],
          next: ["运行打包"],
          blocker: "ABI 尚未验证",
        },
      );
      expect(fromAgent).toMatchObject({
        status: "PUBLISHED",
        health: "AT_RISK",
        risks: ["ABI 尚未验证"],
        opId: "agent-update-1",
        unlinked: true,
        openWorkItems: [open.items[0]!.key],
      });
      const evidenceRecord = await service.createRecord(
        "UPD",
        String(begun.session),
        "project-progress-evidence-record",
        {
          kind: "FACT",
          title: "Project progress evidence",
          summary: "Project progress must retain typed evidence.",
        },
      );
      const evidence = [
        { kind: "atm_task" as const, value: open.items[0]!.key, note: "completed task" },
        { kind: "atm_record" as const, value: evidenceRecord.key },
        { kind: "git_sha" as const, value: "abc123" },
      ];
      const linked = await service.addProjectProgress(
        "UPD",
        String(begun.session),
        "agent-update-linked",
        {
          health: "AT_RISK",
          summary: "任务图已关联",
          completed: [{ text: "完成编译", workItemKey: open.items[0]!.key }],
          evidence,
        },
      );
      expect(linked).toMatchObject({
        opId: "agent-update-linked",
        evidence,
        unlinked: false,
        openWorkItems: [],
      });
      expect(await service.getProjectUpdate("UPD", linked.id)).toMatchObject({
        id: linked.id,
        opId: "agent-update-linked",
        evidence,
      });
      expect(
        await service.getOperationTrace("UPD", "agent-update-linked", String(begun.session)),
      ).toMatchObject({
        projectUpdates: [expect.objectContaining({ id: linked.id, evidence })],
      });
      expect(await service.listProjectUpdates("UPD")).toHaveLength(3);
      expect((service.overview().projects as any[])[0]).toMatchObject({ health: "AT_RISK" });
    } finally {
      service.close();
    }
  });

  it("project progress 严格校验 evidence 公开 key，并保持失败零写入与幂等", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-project-evidence-key-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "Evidence key", sourcePath: null, code: "PEVID" });
      const begun = await service.begin({
        projectCode: "PEVID",
        mode: "project",
        agentId: "project-evidence-agent",
        clientKind: "test",
      });
      const created = await service.createRecord(
        "PEVID",
        String(begun.session),
        "evidence-record",
        {
          kind: "FACT",
          title: "Evidence record",
          summary: "Only its public key is a valid evidence reference.",
        },
      );
      const internalId = (await service.getRecord("PEVID", created.key)).id;
      const objective = await service.createObjectiveAsUser("PEVID", "evidence-objective", {
        title: "Evidence task",
        description: "",
        definitionOfDone: [],
      });
      const task = await service.createWorkItemsAsUser("PEVID", "evidence-task", [
        {
          clientRef: "evidence-task",
          objectiveId: objective.id,
          title: "Evidence task",
          description: "",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          acceptance: [],
          checklist: [],
          verificationRequired: false,
        },
      ]);
      const before = await service.listProjectUpdates("PEVID");

      const invalidEvidence = [
        { opId: "invalid-internal-record", kind: "atm_record" as const, value: internalId },
        { opId: "invalid-cross-record", kind: "atm_record" as const, value: "OTHER-R-001" },
        { opId: "invalid-unknown-record", kind: "atm_record" as const, value: "PEVID-R-999" },
        { opId: "invalid-cross-task", kind: "atm_task" as const, value: "OTHER-T-0001" },
        { opId: "invalid-unknown-task", kind: "atm_task" as const, value: "PEVID-T-9999" },
      ];
      for (const invalid of invalidEvidence) {
        await expect(
          service.addProjectProgress("PEVID", String(begun.session), invalid.opId, {
            summary: "Invalid evidence reference",
            evidence: [{ kind: invalid.kind, value: invalid.value }],
          }),
        ).rejects.toThrowError(/(?:RECORD|WORK_ITEM)_NOT_FOUND/u);
        expect(await service.listProjectUpdates("PEVID")).toEqual(before);
        await expect(
          service.getOperationTrace("PEVID", invalid.opId, String(begun.session)),
        ).rejects.toThrowError(`OPERATION_NOT_FOUND: ${invalid.opId}`);
      }

      const validInput = {
        health: "ON_TRACK" as const,
        summary: "Typed evidence is durable",
        evidence: [
          { kind: "atm_record" as const, value: created.key },
          { kind: "atm_task" as const, value: task.items[0]!.key },
          { kind: "git_sha" as const, value: "abc123" },
        ],
      };
      const published = await service.addProjectProgress(
        "PEVID",
        String(begun.session),
        "project-evidence-idempotent",
        validInput,
      );
      const replayed = await service.addProjectProgress(
        "PEVID",
        String(begun.session),
        "project-evidence-idempotent",
        validInput,
      );
      expect(replayed).toMatchObject({
        id: published.id,
        seq: published.seq,
        evidence: validInput.evidence,
      });
      await expect(
        service.addProjectProgress("PEVID", String(begun.session), "project-evidence-idempotent", {
          ...validInput,
          evidence: [{ kind: "git_sha", value: "different" }],
        }),
      ).rejects.toThrowError("IDEMPOTENCY_CONFLICT");
      expect(await service.listProjectUpdates("PEVID")).toHaveLength(1);
      expect(
        await service.getOperationTrace(
          "PEVID",
          "project-evidence-idempotent",
          String(begun.session),
        ),
      ).toMatchObject({
        projectUpdates: [
          expect.objectContaining({ id: published.id, evidence: validInput.evidence }),
        ],
      });
    } finally {
      service.close();
    }
  });

  it("总览暴露进度来源并统计过期 claim", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-overview-attention-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "注意力测试", sourcePath: null, code: "ATTN" });
      const objective = await service.createObjectiveAsUser("ATTN", "objective-1", {
        title: "防止死亡占用",
        description: "",
        definitionOfDone: [],
      });
      const created = await service.createWorkItemsAsUser("ATTN", "task-1", [
        {
          clientRef: "stale",
          objectiveId: objective.id,
          title: "释放过期 claim",
          description: "",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          acceptance: [],
          checklist: [],
          verificationRequired: false,
        },
      ]);
      const session = await service.begin({
        projectCode: "ATTN",
        mode: "project",
        agentId: "stale-agent",
        clientKind: "test",
      });
      await service.patchWorkItems("ATTN", String(session.session), "claim-1", [
        {
          taskKey: created.items[0]!.key,
          expectedVersion: created.items[0]!.version,
          operation: "claim",
          takeoverStale: false,
        },
      ]);
      const database = await service.databases.openProject("ATTN");
      database.sqlite
        .prepare("UPDATE work_items SET claim_lease_until = '2000-01-01T00:00:00.000Z'")
        .run();
      database.sqlite
        .prepare("UPDATE project_meta SET current_sequence = current_sequence + 1")
        .run();
      await service.databases.dispatchProject("ATTN");

      expect((service.overview().projects as any[])[0]).toMatchObject({
        progress_source: "CHILDREN",
        stale_claim_count: 1,
      });
    } finally {
      service.close();
    }
  });
});
