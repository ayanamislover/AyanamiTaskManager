import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "@ayanami-task/storage-sqlite";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function spawnStartupSuccessorWorker(input: {
  dataDir: string;
  migrationsRoot: string;
  projectCode: string;
  oldSession: string;
  operationId: string;
  readyPath: string;
  goPath: string;
}) {
  const child = spawn(
    process.execPath,
    [
      resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
      resolve(process.cwd(), "packages/application/test/fixtures/startup-successor-worker.ts"),
      input.dataDir,
      input.migrationsRoot,
      input.projectCode,
      input.oldSession,
      input.operationId,
      input.readyPath,
      input.goPath,
    ],
    { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<Record<string, unknown>>((resolveCompletion, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`startup successor worker exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolveCompletion(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        reject(new Error(`startup successor worker returned malformed output: ${stdout}`));
      }
    });
  });
  return { child, completion };
}

async function waitForFiles(paths: string[], timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (paths.some((path) => !existsSync(path))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${paths.join(", ")}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

describe("Session retirement 与低成本恢复", () => {
  it("heartbeat recovery 后首个 mutation 原子创建唯一 successor 并返回新 Session", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-startup-successor-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({
        name: "Startup successor",
        sourcePath: null,
        code: "SRECOVER",
      });
      const first = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "startup-agent",
        displayName: "Startup Agent",
        clientKind: "test",
        threadId: "thread-startup-1",
        role: "SUBAGENT",
      });
      const repository = new ProjectRepository(await service.databases.openProject(project.code));
      repository.recoverStaleSessions("2999-01-01T00:00:00.000Z");
      const input = {
        kind: "FACT",
        title: "自动恢复",
        summary: "首个 mutation 创建 successor",
      };

      const created = await service.createRecord(
        project.code,
        String(first.session),
        "startup-successor-record",
        input,
      );
      const sessions = await service.listAgentSessions(project.code, 20);
      const successor = sessions.find((session) => session.id === created.newSession);

      expect(created).toMatchObject({
        sessionRebound: true,
        newSession: expect.any(String),
        session: expect.any(String),
      });
      expect(created.newSession).toBe(created.session);
      expect(successor).toMatchObject({
        id: created.newSession,
        agent_id: "startup-agent",
        thread_id: "thread-startup-1",
        role: "SUBAGENT",
        connection_state: "ONLINE",
      });
      expect(repository.getSession(String(created.newSession)).predecessor_session_id).toBe(
        String(first.session),
      );
      await expect(
        service.createRecord(
          project.code,
          String(first.session),
          "startup-successor-record",
          input,
        ),
      ).resolves.toMatchObject({ key: created.key, sessionRebound: true });
      await expect(
        service.createRecord(
          project.code,
          String(created.newSession),
          "startup-successor-record",
          input,
        ),
      ).resolves.toMatchObject({ key: created.key });
      await expect(
        service.createRecord(project.code, String(first.session), "startup-successor-record", {
          ...input,
          summary: "相同 op 不同 payload",
        }),
      ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/u);
      await expect(
        service.createRecord(project.code, String(created.newSession), "startup-successor-record", {
          ...input,
          summary: "new Session 上的不同 payload",
        }),
      ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/u);
      expect(await service.listRecords(project.code)).toHaveLength(1);
    } finally {
      service.close();
    }
  });

  it("自动 successor 不迁移旧 Session 的 claim 或 current task", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-startup-successor-claim-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({
        name: "Successor claim isolation",
        sourcePath: null,
        code: "SRCLAIM",
      });
      const objective = await service.createObjectiveAsUser(project.code, "claim-objective", {
        title: "Claim 不迁移",
        description: "",
        definitionOfDone: [],
      });
      const created = await service.createWorkItemsAsUser(project.code, "claim-task", [
        {
          clientRef: "claim-task",
          objectiveId: objective.id,
          title: "保留 stale claim",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
        },
      ]);
      const first = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "claim-agent",
        clientKind: "test",
      });
      const claimed = await service.patchWorkItems(
        project.code,
        String(first.session),
        "claim-before-recovery",
        [
          {
            taskKey: created.items[0]!.key,
            expectedVersion: created.items[0]!.version,
            operation: "claim",
            takeoverStale: false,
          },
        ],
      );
      const repository = new ProjectRepository(await service.databases.openProject(project.code));
      repository.recoverStaleSessions("2999-01-01T00:00:00.000Z");
      const record = await service.createRecord(
        project.code,
        String(first.session),
        "claim-isolation-record",
        { kind: "FACT", title: "触发恢复", summary: "不接管 claim" },
      );

      expect(await service.getWorkItem(project.code, created.items[0]!.key)).toMatchObject({
        status: claimed.items[0]!.status,
        claimedBySessionId: String(first.session),
      });
      expect(repository.getSession(String(record.newSession))).toMatchObject({
        current_work_item_id: null,
        work_state: "PLANNING",
      });
    } finally {
      service.close();
    }
  });

  it("两个服务并发恢复只创建一个 successor 和一次领域写入", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-startup-successor-concurrency-"));
    temporary.push(dataDir);
    const migrationsRoot = resolve(process.cwd(), "migrations");
    const readyLeft = resolve(dataDir, "left.ready");
    const readyRight = resolve(dataDir, "right.ready");
    const goPath = resolve(dataDir, "go.signal");
    const bootstrap = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    const project = await bootstrap.createProject({
      name: "Concurrent startup successor",
      sourcePath: null,
      code: "SRCONCUR",
    });
    const first = await bootstrap.begin({
      projectCode: project.code,
      mode: "project",
      agentId: "concurrent-agent",
      clientKind: "test",
      threadId: "concurrent-thread",
    });
    const repository = new ProjectRepository(await bootstrap.databases.openProject(project.code));
    repository.recoverStaleSessions("2999-01-01T00:00:00.000Z");
    bootstrap.close();

    const common = {
      dataDir,
      migrationsRoot,
      projectCode: project.code,
      oldSession: String(first.session),
      operationId: "concurrent-successor-record",
      goPath,
    };
    const left = spawnStartupSuccessorWorker({ ...common, readyPath: readyLeft });
    const right = spawnStartupSuccessorWorker({ ...common, readyPath: readyRight });
    try {
      await waitForFiles([readyLeft, readyRight]);
      writeFileSync(goPath, "go", "utf8");
      const [leftResult, rightResult] = await Promise.all([left.completion, right.completion]);

      expect(leftResult.key).toBe(rightResult.key);
      expect(leftResult.newSession).toBe(rightResult.newSession);
      const verifier = await AyanamiTaskService.open({ dataDir, migrationsRoot });
      try {
        expect(await verifier.listAgentSessions(project.code, 20)).toHaveLength(2);
        expect(await verifier.listRecords(project.code, 20)).toHaveLength(1);
        expect(
          (await verifier.delta(project.code, 0, 100, ["record.created"])).events,
        ).toHaveLength(1);
      } finally {
        verifier.close();
      }
    } finally {
      for (const worker of [left.child, right.child]) {
        if (worker.exitCode === null) worker.kill();
      }
    }
  });

  it("领域 mutation 失败时 successor、事件与幂等键一并回滚", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-startup-successor-rollback-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({
        name: "Startup successor rollback",
        sourcePath: null,
        code: "SRROLL",
      });
      const first = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "rollback-agent",
        clientKind: "test",
      });
      const repository = new ProjectRepository(await service.databases.openProject(project.code));
      repository.recoverStaleSessions("2999-01-01T00:00:00.000Z");
      const sequenceBefore = (await service.delta(project.code, 0, 100)).currentSequence;

      await expect(
        service.createRecord(project.code, String(first.session), "rollback-successor", {
          kind: "FACT",
          title: "失败 mutation",
          summary: "successor 不能半落账",
          workItemKey: "SRROLL-T-9999",
        }),
      ).rejects.toThrow(/WORK_ITEM_NOT_FOUND/u);
      expect(await service.listAgentSessions(project.code, 20)).toHaveLength(1);
      expect(await service.listRecords(project.code, 20)).toHaveLength(0);
      expect((await service.delta(project.code, 0, 100)).currentSequence).toBe(sequenceBefore);

      await expect(
        service.createRecord(project.code, String(first.session), "rollback-successor", {
          kind: "FACT",
          title: "修正 mutation",
          summary: "同 op 修正后可以成功",
        }),
      ).resolves.toMatchObject({ sessionRebound: true, newSession: expect.any(String) });
      expect(await service.listAgentSessions(project.code, 20)).toHaveLength(2);
      expect(await service.listRecords(project.code, 20)).toHaveLength(1);
    } finally {
      service.close();
    }
  });

  it("在 application actor 检查前回放旧 Session 写入，并沿显式 successor 保持幂等", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-rotation-replay-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "回放测试", sourcePath: null, code: "REPLAY" });
      const first = await service.begin({
        projectCode: "REPLAY",
        mode: "project",
        agentId: "codex",
        clientKind: "test",
      });
      const input = {
        kind: "FACT",
        title: "响应可能丢失",
        summary: "同一 op 必须只落一条记录",
        detail: "application 不得先用 SESSION_CLOSED 拒绝",
      };
      const created = await service.createRecord(
        "REPLAY",
        String(first.session),
        "lost-record",
        input,
      );
      const endInput = {
        outcome: "retired" as const,
        summary: "切换 Session",
        next: ["继续"],
        releaseClaims: true,
        retirementReason: "context rotation",
      };
      const ended = await service.end("REPLAY", String(first.session), "lost-end", endInput);
      const replayed = await service.createRecord(
        "REPLAY",
        String(first.session),
        "lost-record",
        input,
      );
      expect(replayed).toMatchObject({ key: created.key, opId: "lost-record" });
      expect(await service.listRecords("REPLAY")).toHaveLength(1);
      expect(
        await service.end("REPLAY", String(first.session), "lost-end", endInput),
      ).toMatchObject({ seq: ended.seq, opId: "lost-end" });

      const successor = await service.begin({
        projectCode: "REPLAY",
        mode: "project",
        agentId: "codex",
        clientKind: "test",
        resume: true,
        predecessorSessionId: String(first.session),
      });
      expect(
        await service.createRecord("REPLAY", String(successor.session), "lost-record", input),
      ).toMatchObject({ key: created.key, opId: "lost-record" });
      await expect(
        service.createRecord("REPLAY", String(successor.session), "lost-record", {
          ...input,
          summary: "相同 op 的不同载荷必须冲突",
        }),
      ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/u);
      expect(await service.listRecords("REPLAY")).toHaveLength(1);
    } finally {
      service.close();
    }
  });

  it("同一 Agent successor 恢复当前任务、handoff 和 USER 约束，且不误完成任务", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-rotation-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "轮换测试", sourcePath: null, code: "ROT" });
      const objective = await service.createObjectiveAsUser("ROT", "objective-1", {
        title: "稳定交接",
        description: "",
        definitionOfDone: [],
      });
      const created = await service.createWorkItemsAsUser("ROT", "task-1", [
        {
          clientRef: "rotation",
          objectiveId: objective.id,
          title: "完成 successor 恢复",
          description: "长 Session 退役后继续",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
          acceptance: ["恢复当前任务", "保留用户约束"],
          checklist: [],
          verificationRequired: false,
        },
      ]);
      const task = created.items[0]!;
      const first = await service.begin({
        projectCode: "ROT",
        mode: "project",
        agentId: "codex",
        clientKind: "test",
      });
      const started = await service.patchWorkItems("ROT", String(first.session), "start-1", [
        {
          taskKey: task.key,
          expectedVersion: task.version,
          operation: "start",
          takeoverStale: false,
        },
      ]);
      await service.createRecordAsUser("ROT", "constraint-1", {
        kind: "CONSTRAINT",
        title: "用户约束",
        summary: "禁止重新审计已完成阶段",
        detail: "只做增量实现",
        importance: "HIGH",
        scope: "PROJECT",
      });
      const blocked = await service.patchWorkItems("ROT", String(first.session), "block-1", [
        {
          taskKey: task.key,
          expectedVersion: started.items[0]!.version,
          operation: "block",
          blockedReason: "等待恢复测试",
          takeoverStale: false,
        },
      ]);
      const ended = await service.end("ROT", String(first.session), "retire-1", {
        outcome: "retired",
        summary: "上下文已退役，任务继续",
        next: ["完成验证"],
        releaseClaims: true,
        retirementReason: "compact 频率升高",
      });
      expect(ended.handoffs).toBe(1);

      const successor = await service.begin({
        projectCode: "ROT",
        mode: "project",
        agentId: "codex",
        clientKind: "test",
        resume: true,
        predecessorSessionId: String(first.session),
        maxChars: 1200,
      });
      expect(successor.currentTask).toMatchObject({
        key: task.key,
        status: "BLOCKED",
        version: expect.any(Number),
        acceptance: ["恢复当前任务", "保留用户约束"],
        blockedReason: "等待恢复测试",
        claim: null,
      });
      expect(successor.currentTask.version).toBeGreaterThan(blocked.items[0]!.version);
      expect(successor.handoff).toMatchObject({
        summary: "上下文已退役，任务继续",
        nextAction: "完成验证",
      });
      expect(successor.next).toContain("完成验证");
      expect(successor.records).toContainEqual(
        expect.objectContaining({
          kind: "CONSTRAINT",
          summary: "禁止重新审计已完成阶段",
          source_type: "USER",
        }),
      );
      expect(JSON.stringify(successor).length).toBeLessThanOrEqual(1200);
      expect((await service.getWorkItem("ROT", task.key)).status).toBe("BLOCKED");
    } finally {
      service.close();
    }
  });

  it("默认 brief 排除已取代记录和大量历史噪音", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-rotation-noise-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "噪音测试", sourcePath: null, code: "NOISE" });
      await service.createRecordAsUser("NOISE", "constraint-old", {
        kind: "CONSTRAINT",
        title: "旧约束",
        summary: "使用旧方案",
        detail: "",
        importance: "HIGH",
        scope: "PROJECT",
      });
      const old = (await service.listRecords("NOISE")).find((record) => record.title === "旧约束")!;
      await service.createRecordAsUser("NOISE", "constraint-new", {
        kind: "CONSTRAINT",
        title: "新约束",
        summary: "只使用新方案",
        detail: "",
        importance: "HIGH",
        scope: "PROJECT",
        supersedes: old.id,
      });
      for (let index = 0; index < 40; index += 1) {
        await service.createRecordAsUser("NOISE", `noise-${index}`, {
          kind: "REFERENCE",
          title: `历史 ${index}`,
          summary: `可以重新获取的历史噪音 ${index}`,
          detail: "x".repeat(100),
          importance: "LOW",
          scope: "PROJECT",
        });
      }
      const brief = await service.brief("NOISE", null, 1200);
      expect(JSON.stringify(brief)).not.toContain("使用旧方案");
      expect(JSON.stringify(brief)).toContain("只使用新方案");
      expect(JSON.stringify(brief)).not.toContain("历史 39");
      expect(JSON.stringify(brief).length).toBeLessThanOrEqual(1200);
    } finally {
      service.close();
    }
  });
});
