import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";
import { captureAtmError } from "./typed-error-test-helpers.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 50,
    });
});

async function fixture(code = "CONT") {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-continuity-"));
  temporary.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await manager.createProject({ name: "连续性测试", sourcePath: null, code });
  const repository = new ProjectRepository(await manager.openProject(project.id));
  const session = repository.createSession({
    agentId: "continuity-agent",
    displayName: "Continuity Agent",
    clientKind: "test",
    role: "SUBAGENT",
  });
  const actor = { type: "AGENT" as const, id: "continuity-agent", sessionId: session.id };
  return { manager, repository, session, actor };
}

describe("record 公开引用与主题关联", () => {
  it("supersedes 接受当前项目 record key 或内部 id，未知与错类型都返回 RECORD_NOT_FOUND", async () => {
    const { manager, repository, actor } = await fixture("RKEY");
    try {
      const first = repository.createRecord(actor, "record-first", {
        kind: "DECISION",
        title: "原决策",
        summary: "原决策摘要",
      });
      const firstView = repository.getRecord(first.key);
      expect(firstView).toMatchObject({ key: first.key, kind: "DECISION", status: "ACTIVE" });

      const second = repository.createRecord(actor, "record-by-key", {
        kind: "DECISION",
        title: "按 key 取代",
        summary: "已按公开 key 取代",
        supersedes: first.key,
      });
      expect(repository.getRecord(first.key).status).toBe("SUPERSEDED");
      expect(repository.getRecord(second.key).supersedes).toBe(first.key);

      const third = repository.createRecord(actor, "record-by-id", {
        kind: "FACT",
        title: "按 id 取代",
        summary: "已按内部 id 取代",
        supersedes: repository.getRecord(second.key).id,
      });
      expect(repository.getRecord(third.key).supersedes).toBe(second.key);

      for (const reference of ["RKEY-R-999", "OTHER-D-001", "RKEY-T-0001"]) {
        expect(
          captureAtmError(() =>
            repository.createRecord(actor, `invalid-${reference}`, {
              kind: "FACT",
              title: "错误引用",
              summary: "错误引用不应泄漏 SQLite 外键错误",
              supersedes: reference,
            }),
          ),
        ).toMatchObject({
          code: "RECORD_NOT_FOUND",
          details: { entity: "RECORD", reference },
        });
      }
    } finally {
      manager.close();
    }
  });

  it("保存 topic/subjectKey 并在写入回执投影同项目活动关联记录", async () => {
    const { manager, repository, actor } = await fixture("RTOPIC");
    try {
      const first = repository.createRecord(actor, "topic-first", {
        kind: "RISK",
        title: "风险一",
        summary: "同一主题的第一条",
        topic: "release-integrity",
        subjectKey: "release:v2",
      });
      expect(first.relatedRecords).toEqual([]);
      const second = repository.createRecord(actor, "topic-second", {
        kind: "FACT",
        title: "事实二",
        summary: "同一主题的第二条",
        topic: "release-integrity",
      });
      expect(second.relatedRecords).toEqual([first.key]);
      expect(repository.getRecord(second.key)).toMatchObject({
        topic: "release-integrity",
        subjectKey: null,
      });
      expect(repository.listRecords()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ topic: "release-integrity", subjectKey: "release:v2" }),
        ]),
      );
    } finally {
      manager.close();
    }
  });
});

describe("Session 写入连续性原语", () => {
  it("持久化可判定的 close reason，且显式 force-close 覆盖 recovery 资格", async () => {
    const heartbeat = await fixture("SCLOSEHB");
    const explicit = await fixture("SCLOSEEND");
    const retired = await fixture("SCLOSERET");
    const forced = await fixture("SCLOSEFORCE");
    try {
      heartbeat.repository.recoverStaleSessions("2999-01-01T00:00:00.000Z");
      explicit.repository.endSession(explicit.actor, "explicit-end", {
        outcome: "completed",
        summary: "显式结束",
        releaseClaims: true,
      });
      retired.repository.endSession(retired.actor, "explicit-retire", {
        outcome: "retired",
        summary: "显式退役",
        releaseClaims: true,
        retirementReason: "context rotation",
      });
      forced.repository.recoverStaleSessions("2999-01-01T00:00:00.000Z");
      forced.repository.forceCloseSession(forced.session.id, true);

      expect(heartbeat.repository.getSession(heartbeat.session.id).close_reason).toBe(
        "HEARTBEAT_TIMEOUT",
      );
      expect(explicit.repository.getSession(explicit.session.id).close_reason).toBe("EXPLICIT_END");
      expect(retired.repository.getSession(retired.session.id).close_reason).toBe(
        "EXPLICIT_RETIRE",
      );
      expect(forced.repository.getSession(forced.session.id).close_reason).toBe("FORCE_CLOSE");
    } finally {
      heartbeat.manager.close();
      explicit.manager.close();
      retired.manager.close();
      forced.manager.close();
    }
  });

  it("显式 end、retire、force-close 都不能自动创建 successor", async () => {
    const ended = await fixture("SNOREND");
    const retired = await fixture("SNORRET");
    const forced = await fixture("SNORFORCE");
    const input = { kind: "FACT", title: "不应写入", summary: "显式关闭不能复活" };
    try {
      ended.repository.endSession(ended.actor, "explicit-end", {
        outcome: "completed",
        summary: "显式结束",
        releaseClaims: true,
      });
      retired.repository.endSession(retired.actor, "explicit-retire", {
        outcome: "retired",
        summary: "显式退役",
        releaseClaims: true,
        retirementReason: "context rotation",
      });
      forced.repository.recoverStaleSessions("2999-01-01T00:00:00.000Z");
      forced.repository.forceCloseSession(forced.session.id, true);

      for (const target of [ended, retired, forced]) {
        const sequenceBefore = target.repository.delta(0, 100).currentSequence;
        expect(
          captureAtmError(() =>
            target.repository.executeSessionMutation(
              target.session.id,
              "must-not-revive",
              "record.create",
              input,
              (actor) => target.repository.createRecord(actor, "must-not-revive", input),
            ),
          ),
        ).toMatchObject({
          code: "SESSION_CLOSED",
          details: { entity: "SESSION", reference: target.session.id },
        });
        expect(target.repository.listRecords()).toHaveLength(0);
        expect(target.repository.listAgentSessions()).toHaveLength(1);
        expect(target.repository.delta(0, 100).currentSequence).toBe(sequenceBefore);
      }
    } finally {
      ended.manager.close();
      retired.manager.close();
      forced.manager.close();
    }
  });

  it("多候选或 thread、role、agent 身份不符时 fail closed 且 action 零落账", async () => {
    const threadMismatch = await fixture("SMISTHR");
    const roleMismatch = await fixture("SMISROLE");
    const agentMismatch = await fixture("SMISAGENT");
    const ambiguous = await fixture("SAMBIG");
    const input = { kind: "FACT", title: "不应写入", summary: "候选不可信" };
    try {
      for (const target of [threadMismatch, roleMismatch, agentMismatch, ambiguous]) {
        target.repository.recoverStaleSessions("2999-01-01T00:00:00.000Z");
      }
      threadMismatch.repository.createSession({
        agentId: "continuity-agent",
        displayName: "Continuity Agent",
        clientKind: "test",
        role: "SUBAGENT",
        threadId: "other-thread",
        resume: true,
        predecessorSessionId: threadMismatch.session.id,
      });
      roleMismatch.repository.createSession({
        agentId: "continuity-agent",
        displayName: "Continuity Agent",
        clientKind: "test",
        role: "REVIEWER",
        resume: true,
        predecessorSessionId: roleMismatch.session.id,
      });
      const wrongAgent = agentMismatch.repository.createSession({
        agentId: "other-agent",
        displayName: "Other Agent",
        clientKind: "test",
        role: "SUBAGENT",
      });
      const agentDatabase = await agentMismatch.manager.openProject("SMISAGENT");
      agentDatabase.sqlite
        .prepare("UPDATE agent_sessions SET predecessor_session_id = ? WHERE id = ?")
        .run(agentMismatch.session.id, wrongAgent.id);
      for (let index = 0; index < 2; index += 1) {
        ambiguous.repository.createSession({
          agentId: "continuity-agent",
          displayName: "Continuity Agent",
          clientKind: "test",
          role: "SUBAGENT",
          resume: true,
          predecessorSessionId: ambiguous.session.id,
        });
      }

      for (const target of [threadMismatch, roleMismatch, agentMismatch]) {
        const sequenceBefore = target.repository.delta(0, 100).currentSequence;
        expect(
          captureAtmError(() =>
            target.repository.executeSessionMutation(
              target.session.id,
              "identity-mismatch",
              "record.create",
              input,
              (actor) => target.repository.createRecord(actor, "identity-mismatch", input),
            ),
          ),
        ).toMatchObject({
          code: "SESSION_SUCCESSOR_IDENTITY_MISMATCH",
          details: { session_id: target.session.id },
        });
        expect(target.repository.listRecords()).toHaveLength(0);
        expect(target.repository.delta(0, 100).currentSequence).toBe(sequenceBefore);
      }

      const ambiguousSequence = ambiguous.repository.delta(0, 100).currentSequence;
      expect(
        captureAtmError(() =>
          ambiguous.repository.executeSessionMutation(
            ambiguous.session.id,
            "ambiguous-successor",
            "record.create",
            input,
            (actor) => ambiguous.repository.createRecord(actor, "ambiguous-successor", input),
          ),
        ),
      ).toMatchObject({
        code: "SESSION_SUCCESSOR_AMBIGUOUS",
        details: { session_id: ambiguous.session.id },
      });
      expect(ambiguous.repository.listRecords()).toHaveLength(0);
      expect(ambiguous.repository.delta(0, 100).currentSequence).toBe(ambiguousSequence);
    } finally {
      threadMismatch.manager.close();
      roleMismatch.manager.close();
      agentMismatch.manager.close();
      ambiguous.manager.close();
    }
  });

  it("已关闭 Session 的已提交 session+op 可在 actor 拒绝前精确回放", async () => {
    const { manager, repository, session, actor } = await fixture("SREPLAY");
    try {
      const input = { kind: "FACT", title: "已提交", summary: "响应丢失后应精确回放" };
      const created = repository.createRecord(actor, "lost-response", input);
      repository.recoverStaleSessions("2999-01-01T00:00:00.000Z");

      const resolved = repository.resolveMutationActor(
        session.id,
        "lost-response",
        "record.create",
        input,
      );
      expect(resolved).toMatchObject({ actor, disposition: "REPLAY" });
      expect(repository.createRecord(resolved.actor, "lost-response", input)).toEqual(created);
      expect(
        captureAtmError(() =>
          repository.resolveMutationActor(session.id, "lost-response", "record.create", {
            ...input,
            summary: "不同 payload",
          }),
        ),
      ).toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        details: { session_id: expect.any(String), operation_id: "lost-response" },
      });
    } finally {
      manager.close();
    }
  });

  it("只对异常关闭且唯一的在线后继 rebind，显式 retired 或多后继 fail closed", async () => {
    const abnormal = await fixture("SREBIND");
    try {
      abnormal.repository.recoverStaleSessions("2999-01-01T00:00:00.000Z");
      const successor = abnormal.repository.createSession({
        agentId: "continuity-agent",
        displayName: "Continuity Agent",
        clientKind: "test",
        role: "SUBAGENT",
        resume: true,
        predecessorSessionId: abnormal.session.id,
      });
      expect(
        abnormal.repository.resolveMutationActor(
          abnormal.session.id,
          "new-write",
          "record.create",
          { kind: "FACT" },
        ),
      ).toMatchObject({
        actor: { sessionId: successor.id, id: "continuity-agent" },
        disposition: "REBOUND",
      });
      abnormal.repository.createSession({
        agentId: "continuity-agent",
        displayName: "Continuity Agent",
        clientKind: "test",
        role: "SUBAGENT",
        resume: true,
        predecessorSessionId: abnormal.session.id,
      });
      expect(
        captureAtmError(() =>
          abnormal.repository.resolveMutationActor(
            abnormal.session.id,
            "ambiguous-write",
            "record.create",
            {},
          ),
        ),
      ).toMatchObject({
        code: "SESSION_SUCCESSOR_AMBIGUOUS",
        details: { session_id: abnormal.session.id },
      });
    } finally {
      abnormal.manager.close();
    }

    const explicit = await fixture("SRETIRE");
    try {
      explicit.repository.endSession(explicit.actor, "retire-session", {
        outcome: "retired",
        summary: "显式退役",
        releaseClaims: true,
        retirementReason: "context rotation",
      });
      explicit.repository.createSession({
        agentId: "continuity-agent",
        displayName: "Continuity Agent",
        clientKind: "test",
        role: "SUBAGENT",
        resume: true,
        predecessorSessionId: explicit.session.id,
      });
      expect(
        captureAtmError(() =>
          explicit.repository.resolveMutationActor(
            explicit.session.id,
            "must-not-revive",
            "record.create",
            {},
          ),
        ),
      ).toMatchObject({
        code: "SESSION_CLOSED",
        details: { entity: "SESSION", reference: explicit.session.id },
      });
    } finally {
      explicit.manager.close();
    }
  });

  it("在显式 predecessor lineage 上回放相同 op/payload，对不同 payload 冲突", async () => {
    const { manager, repository, session, actor } = await fixture("SLINE");
    try {
      const input = { kind: "FACT", title: "lineage", summary: "lineage replay" };
      repository.createRecord(actor, "lineage-op", input);
      repository.endSession(actor, "lineage-retire", {
        outcome: "retired",
        summary: "rotate",
        releaseClaims: true,
        retirementReason: "context rotation",
      });
      const successor = repository.createSession({
        agentId: "continuity-agent",
        displayName: "Continuity Agent",
        clientKind: "test",
        role: "SUBAGENT",
        resume: true,
        predecessorSessionId: session.id,
      });
      expect(
        repository.resolveMutationActor(successor.id, "lineage-op", "record.create", input),
      ).toMatchObject({ actor: { sessionId: session.id }, disposition: "REPLAY" });
      expect(
        captureAtmError(() =>
          repository.resolveMutationActor(successor.id, "lineage-op", "record.create", {
            ...input,
            detail: "changed",
          }),
        ),
      ).toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        details: { session_id: expect.any(String), operation_id: "lineage-op" },
      });
    } finally {
      manager.close();
    }
  });
});

describe("工作项原子基础与完成诊断", () => {
  it("创建时可在同一事务内设置 assigneeAgentId", async () => {
    const { manager, repository, actor } = await fixture("ASSIGN");
    try {
      const objective = repository.createObjective(actor, {
        title: "原子分派",
        description: "",
        definitionOfDone: [],
      });
      const created = repository.createWorkItems(actor, "create-assigned", [
        {
          clientRef: "assigned",
          objectiveId: objective.id,
          title: "创建即分派",
          type: "REVIEW",
          priority: "HIGH",
          status: "READY",
          assigneeAgentId: "claude-reviewer",
        },
      ]);
      expect(created.items[0]?.assigneeAgentId).toBe("claude-reviewer");
    } finally {
      manager.close();
    }
  });

  it("完成门禁按固定类别顺序一次返回每类全部缺口", async () => {
    const { manager, repository, actor } = await fixture("GATES");
    try {
      const objective = repository.createObjective(actor, {
        title: "门禁",
        description: "",
        definitionOfDone: [],
      });
      const created = repository.createWorkItems(actor, "gate-items", [
        {
          clientRef: "dependency-a",
          objectiveId: objective.id,
          title: "未完成依赖 A",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
        },
        {
          clientRef: "dependency-b",
          objectiveId: objective.id,
          title: "未完成依赖 B",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
        },
        {
          clientRef: "parent",
          objectiveId: objective.id,
          title: "父任务",
          type: "TASK",
          priority: "HIGH",
          status: "CLAIMED",
          dependsOnRefs: ["dependency-a", "dependency-b"],
          verificationRequired: true,
          checklist: [
            { title: "必需证据 A", evidenceRequired: true },
            { title: "必需证据 B", evidenceRequired: true },
          ],
        },
        {
          clientRef: "child-a",
          objectiveId: objective.id,
          parentRef: "parent",
          title: "未完成子任务 A",
          type: "SUBTASK",
          priority: "NORMAL",
          status: "READY",
        },
        {
          clientRef: "child-b",
          objectiveId: objective.id,
          parentRef: "parent",
          title: "未完成子任务 B",
          type: "SUBTASK",
          priority: "NORMAL",
          status: "READY",
        },
      ]);
      const parent = created.items.find((item) => item.title === "父任务")!;
      repository.addProgress(actor, "gate-blocker", {
        taskKey: parent.key,
        summary: "发现阻塞 A",
        blocker: "外部条件 A 未满足",
      });
      repository.addProgress(actor, "gate-blocker-b", {
        taskKey: parent.key,
        summary: "发现阻塞 B",
        blocker: "外部条件 B 未满足",
      });
      const current = repository.getWorkItem(parent.key);
      const first = captureAtmError(() =>
        repository.patchWorkItems(actor, "gate-complete", [
          { taskKey: parent.key, expectedVersion: current.version, operation: "complete" },
        ]),
      );
      const second = captureAtmError(() =>
        repository.patchWorkItems(actor, "gate-complete-repeat", [
          { taskKey: parent.key, expectedVersion: current.version, operation: "complete" },
        ]),
      );
      expect(first).toMatchObject({
        code: "COMPLETION_GATE_FAILED",
        details: {
          reasons: expect.any(Array),
          truncated: false,
          truncation: [],
        },
      });
      expect(second.details).toEqual(first.details);
      const reasons = first.details?.reasons ?? [];
      expect(reasons.map((reason) => reason.code)).toEqual([
        "CHECKLIST_INCOMPLETE",
        "CHECKLIST_INCOMPLETE",
        "EVIDENCE_MISSING",
        "EVIDENCE_MISSING",
        "CHILD_INCOMPLETE",
        "CHILD_INCOMPLETE",
        "BLOCKER_ACTIVE",
        "BLOCKER_ACTIVE",
        "DEPENDENCY_INCOMPLETE",
        "DEPENDENCY_INCOMPLETE",
        "VERIFICATION_REQUIRED",
        "CURRENT_STATE_INVALID",
      ]);
      expect(
        reasons
          .filter((reason) => reason.code === "CHECKLIST_INCOMPLETE")
          .map((reason) => reason.checklist_id),
      ).toEqual(current.checklist.map((item) => item.id).sort());
      expect(
        reasons
          .filter((reason) => reason.code === "CHILD_INCOMPLETE")
          .map((reason) => reason.work_item_id),
      ).toEqual(created.items.filter((item) => item.parentId === parent.id).map((item) => item.id));
      expect(
        reasons
          .filter((reason) => reason.code === "DEPENDENCY_INCOMPLETE")
          .map((reason) => reason.work_item_id),
      ).toEqual(
        created.items.filter((item) => item.title.startsWith("未完成依赖")).map((item) => item.id),
      );
      expect(
        new Set(
          reasons
            .filter((reason) => reason.code === "BLOCKER_ACTIVE")
            .map((reason) => reason.blocker_id),
        ).size,
      ).toBe(2);
    } finally {
      manager.close();
    }
  });

  it("完成门禁对超量实体显式返回精确截断元数据", async () => {
    const { manager, repository, actor } = await fixture("GATELIMIT");
    try {
      const objective = repository.createObjective(actor, {
        title: "有界门禁",
        description: "",
        definitionOfDone: [],
      });
      const checklist = Array.from({ length: 55 }, (_, index) => ({
        title: `验收项 ${String(index + 1).padStart(2, "0")}`,
      }));
      const created = repository.createWorkItems(actor, "gate-limit-item", [
        {
          clientRef: "bounded-parent",
          objectiveId: objective.id,
          title: "有界完成门",
          type: "TASK",
          priority: "HIGH",
          status: "IN_PROGRESS",
          checklist,
        },
      ]).items[0]!;
      const current = repository.getWorkItem(created.key);
      const error = captureAtmError(() =>
        repository.patchWorkItems(actor, "gate-limit-complete", [
          { taskKey: created.key, expectedVersion: current.version, operation: "complete" },
        ]),
      );

      expect(error).toMatchObject({
        code: "COMPLETION_GATE_FAILED",
        details: {
          reason_limit_per_predicate: 50,
          truncated: true,
          truncation: [{ predicate: "checklist", total: 55, included: 50, omitted: 5 }],
        },
      });
      const reasons = error.details?.reasons ?? [];
      expect(reasons).toHaveLength(50);
      expect(reasons.every((reason) => reason.code === "CHECKLIST_INCOMPLETE")).toBe(true);
      expect(
        reasons.map((reason) =>
          reason.code === "CHECKLIST_INCOMPLETE" ? reason.checklist_id : undefined,
        ),
      ).toEqual(
        current.checklist
          .map((item) => item.id)
          .sort()
          .slice(0, 50),
      );
    } finally {
      manager.close();
    }
  });
});

describe("证据解引用、项目进度回执与 op 追踪", () => {
  it("atm_record/atm_task 证据严格解引用，失败时整笔回滚", async () => {
    const { manager, repository, actor } = await fixture("EVID");
    try {
      const objective = repository.createObjective(actor, {
        title: "证据",
        description: "",
        definitionOfDone: [],
      });
      const task = repository.createWorkItems(actor, "evidence-task", [
        {
          clientRef: "evidence",
          objectiveId: objective.id,
          title: "证据任务",
          type: "TASK",
          priority: "NORMAL",
          status: "IN_PROGRESS",
          checklist: [{ title: "验证证据", evidenceRequired: true }],
        },
      ]).items[0]!;
      const record = repository.createRecord(actor, "evidence-record", {
        kind: "FACT",
        title: "证据记录",
        summary: "可解引用的 record",
      });
      const checklist = repository.getWorkItem(task.key).checklist[0]!;
      const checked = repository.updateChecklist(actor, "structured-evidence", {
        checklistId: checklist.id,
        expectedVersion: checklist.version,
        status: "DONE",
        evidence: [
          "legacy evidence",
          { kind: "atm_record", value: record.key },
          { kind: "atm_task", value: task.key, note: "covered" },
          { kind: "git_sha", value: "abc123" },
        ],
      });
      expect(checked.checklist.evidence).toEqual([
        "legacy evidence",
        { kind: "atm_record", value: record.key },
        { kind: "atm_task", value: task.key, note: "covered" },
        { kind: "git_sha", value: "abc123" },
      ]);

      const before = repository.getWorkItem(task.key).checklist[0]!;
      const sequence = repository.meta.sequence;
      expect(
        captureAtmError(() =>
          repository.updateChecklist(actor, "invalid-structured-evidence", {
            checklistId: before.id,
            expectedVersion: before.version,
            status: "DONE",
            evidence: [{ kind: "atm_record", value: "EVID-R-999" }],
          }),
        ),
      ).toMatchObject({
        code: "RECORD_NOT_FOUND",
        details: { entity: "RECORD", reference: "EVID-R-999" },
      });
      expect(repository.getWorkItem(task.key).checklist[0]).toMatchObject({
        version: before.version,
        evidence: before.evidence,
      });
      expect(repository.meta.sequence).toBe(sequence);
    } finally {
      manager.close();
    }
  });

  it("project progress 严格解引用 completed 并返回 unlinked/openWorkItems 提示", async () => {
    const { manager, repository, actor } = await fixture("PGRAPH");
    try {
      const objective = repository.createObjective(actor, {
        title: "任务图",
        description: "",
        definitionOfDone: [],
      });
      const tasks = repository.createWorkItems(actor, "graph-tasks", [
        {
          clientRef: "left",
          objectiveId: objective.id,
          title: "已关联",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
        },
        {
          clientRef: "right",
          objectiveId: objective.id,
          title: "尚未关联",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
        },
      ]).items;
      const linked = repository.publishProjectUpdate(actor, "graph-progress", {
        health: "ON_TRACK",
        summary: "完成关联项",
        completed: [{ text: "完成左侧", workItemKey: tasks[0]!.key }],
      });
      expect(linked).toMatchObject({
        opId: "graph-progress",
        unlinked: true,
        openWorkItems: [tasks[1]!.key],
      });

      const sequence = repository.meta.sequence;
      expect(
        captureAtmError(() =>
          repository.publishProjectUpdate(actor, "bad-graph-progress", {
            health: "ON_TRACK",
            summary: "错项目 key",
            completed: [{ text: "错误", workItemKey: "OTHER-T-0001" }],
          }),
        ),
      ).toMatchObject({
        code: "WORK_ITEM_NOT_FOUND",
        details: { entity: "WORK_ITEM", reference: "OTHER-T-0001" },
      });
      expect(repository.meta.sequence).toBe(sequence);
    } finally {
      manager.close();
    }
  });

  it("records/progress/events/idempotency 保留 opId 并可精确回查", async () => {
    const { manager, repository, actor } = await fixture("OPTRACE");
    try {
      const record = repository.createRecord(actor, "trace-record", {
        kind: "FACT",
        title: "trace",
        summary: "traceable",
      });
      expect(repository.getRecord(record.key).opId).toBe("trace-record");
      expect(repository.getOperationTrace("trace-record", actor.sessionId!)).toMatchObject({
        opId: "trace-record",
        mutations: [
          expect.objectContaining({ operation: "record.create", sessionId: actor.sessionId }),
        ],
        records: [expect.objectContaining({ key: record.key, opId: "trace-record" })],
        events: [expect.objectContaining({ opId: "trace-record", type: "record.created" })],
      });
      expect(repository.delta(0, 100).events).toEqual(
        expect.arrayContaining([expect.objectContaining({ opId: "trace-record" })]),
      );
    } finally {
      manager.close();
    }
  });
});
