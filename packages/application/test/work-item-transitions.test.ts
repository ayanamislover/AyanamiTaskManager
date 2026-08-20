import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORK_ITEM_TRANSITIONS, type WorkItemStatus } from "@ayanami-task/protocol";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
const openServices: Array<{ close: () => void }> = [];
// 必须先关库再删目录：Windows 上 sqlite 文件还被句柄占着时 rmSync 会 EPERM。
afterAll(() => {
  for (const service of openServices.splice(0)) {
    try {
      service.close();
    } catch {
      // 已经关过就算了
    }
  }
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// 每个操作在仓储层能改状态的那一次调用。edit 不改状态，因此不在其列。
const OPERATIONS = [
  { operation: "claim" },
  { operation: "start" },
  { operation: "release" },
  { operation: "block", blockedReason: "等外部依赖" },
  { operation: "wait_user", waitingFor: "等用户确认口径" },
  { operation: "wait_agent", waitingFor: "等 reviewer" },
  { operation: "verify" },
  { operation: "complete" },
  { operation: "cancel" },
  { operation: "reopen" },
] as const;

const STATUSES = Object.keys(WORK_ITEM_TRANSITIONS) as WorkItemStatus[];

type Harness = Awaited<ReturnType<typeof openHarness>>;

async function openHarness() {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-transitions-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await service.createProject({ name: "状态机守卫", sourcePath: null });
  const begun = await service.begin({
    projectCode: project.code,
    agentId: "codex",
    displayName: "Codex",
    role: "PRIMARY",
  });
  const objective = await service.createObjective(project.code, begun.session, {
    title: "目标",
    description: "",
    definitionOfDone: ["完成"],
  });
  let counter = 0;
  const nextId = () => `op-${(counter += 1)}`;

  const patch = async (taskKey: string, input: Record<string, unknown>) => {
    const fresh = await service.getWorkItem(project.code, taskKey, "core");
    const result = await service.patchWorkItems(project.code, begun.session, nextId(), [
      { taskKey, expectedVersion: fresh.version, ...input } as never,
    ]);
    return result.items[0]!;
  };

  // 把一个新任务开到指定状态。这些路径本身也是「声明的转移确实可达」的一部分。
  const taskAt = async (status: WorkItemStatus) => {
    const seed = status === "BACKLOG" ? "BACKLOG" : ("READY" as const);
    const created = await service.createWorkItems(project.code, begun.session, nextId(), [
      {
        clientRef: `t-${counter}-${status}`,
        objectiveId: objective.id,
        title: `处于 ${status} 的任务`,
        type: "TASK",
        priority: "NORMAL",
        status: seed,
      },
    ]);
    const key = created.items[0]!.key;
    if (status === "BACKLOG" || status === "READY") return key;
    if (status === "CANCELLED") {
      await patch(key, { operation: "cancel" });
      return key;
    }
    if (status === "CLAIMED") {
      await patch(key, { operation: "claim" });
      return key;
    }
    await patch(key, { operation: "start" });
    if (status === "IN_PROGRESS") return key;
    if (status === "BLOCKED") await patch(key, { operation: "block", blockedReason: "外部依赖" });
    else if (status === "WAITING_USER")
      await patch(key, { operation: "wait_user", waitingFor: "等用户" });
    else if (status === "WAITING_AGENT")
      await patch(key, { operation: "wait_agent", waitingFor: "等 Agent" });
    else if (status === "VERIFYING") await patch(key, { operation: "verify" });
    else if (status === "DONE") {
      await patch(key, { operation: "verify" });
      await patch(key, { operation: "complete" });
    }
    return key;
  };

  const read = (taskKey: string) => service.getWorkItem(project.code, taskKey, "core");
  openServices.push(service);
  return { service, patch, taskAt, read };
}

// 把所有 (来源状态 x 操作) 跑一遍，记下每个真正落地的状态变化。
async function sweep(harness: Harness) {
  const observed = new Map<WorkItemStatus, Map<WorkItemStatus, string[]>>();
  for (const from of STATUSES) {
    const landed = new Map<WorkItemStatus, string[]>();
    for (const candidate of OPERATIONS) {
      const key = await harness.taskAt(from);
      try {
        const after = await harness.patch(key, { ...candidate });
        const to = after.status as WorkItemStatus;
        if (to === from) continue;
        landed.set(to, [...(landed.get(to) ?? []), candidate.operation]);
      } catch {
        // 被拒绝就是被拒绝，本轮只统计真正发生的转移。
      }
    }
    observed.set(from, landed);
  }
  return observed;
}

describe("WorkItem 状态机：转移表与操作必须双向吻合", () => {
  let harness: Harness;
  let observed: Awaited<ReturnType<typeof sweep>>;

  beforeAll(async () => {
    harness = await openHarness();
    observed = await sweep(harness);
  }, 120_000);

  it("扫描面非空：确实跑出了状态变化，守卫不是在空转", () => {
    const total = [...observed.values()].reduce((sum, m) => sum + m.size, 0);
    expect(STATUSES.length).toBe(10);
    expect(total).toBeGreaterThanOrEqual(20);
  });

  it("声明的每一条转移都必须有操作能真正执行", () => {
    const unreachable: string[] = [];
    for (const from of STATUSES) {
      for (const to of WORK_ITEM_TRANSITIONS[from]) {
        if (!observed.get(from)?.has(to)) unreachable.push(`${from} -> ${to}`);
      }
    }
    expect(unreachable).toEqual([]);
  });

  it("没有操作能执行表里未声明的转移", () => {
    const undeclared: string[] = [];
    for (const from of STATUSES) {
      for (const [to, ops] of observed.get(from) ?? []) {
        if (!WORK_ITEM_TRANSITIONS[from].includes(to)) {
          undeclared.push(`${from} -> ${to} (${ops.join("/")})`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });
});

describe("界面上那几个出口必须真的能走", () => {
  // BLOCKED / WAITING_USER / WAITING_AGENT 的「重新打开」与 VERIFYING 的「退回」
  // 都调 reopen；reopen 若一律指向 BACKLOG，这四个按钮点下去必然 INVALID_TRANSITION。
  const parked = ["BLOCKED", "WAITING_USER", "WAITING_AGENT", "VERIFYING"] as const;

  it("reopen 把停住的任务拉回 IN_PROGRESS，保留领取并清掉已失效的原因", async () => {
    const harness = await openHarness();
    try {
      for (const from of parked) {
        const key = await harness.taskAt(from);
        const before = await harness.read(key);
        expect(before.status).toBe(from);
        const after = await harness.patch(key, { operation: "reopen" });
        expect(`${from}:${after.status}`).toBe(`${from}:IN_PROGRESS`);
        const detail = await harness.read(key);
        expect(detail.assigneeAgentId).toBe(before.assigneeAgentId);
        expect(detail.claimedBySessionId).toBe(before.claimedBySessionId);
        expect(detail.blockedReason).toBeNull();
        expect(detail.waitingFor).toBeNull();
      }
    } finally {
      harness.service.close();
    }
  }, 60_000);

  it("start 能直接把停住的任务接回来，且对已在进行中的任务是幂等的", async () => {
    const harness = await openHarness();
    try {
      for (const from of ["BLOCKED", "WAITING_USER", "WAITING_AGENT"] as const) {
        const key = await harness.taskAt(from);
        const after = await harness.patch(key, { operation: "start" });
        expect(`${from}:${after.status}`).toBe(`${from}:IN_PROGRESS`);
      }
      const running = await harness.taskAt("IN_PROGRESS");
      const again = await harness.patch(running, { operation: "start" });
      expect(again.status).toBe("IN_PROGRESS");
    } finally {
      harness.service.close();
    }
  }, 60_000);

  it("release 不能把终态任务悄悄拉回 READY", async () => {
    const harness = await openHarness();
    try {
      for (const from of ["DONE", "CANCELLED"] as const) {
        const key = await harness.taskAt(from);
        await expect(harness.patch(key, { operation: "release" })).rejects.toThrow(
          /INVALID_TRANSITION|CLAIM_OWNER_REQUIRED/,
        );
        expect((await harness.read(key)).status).toBe(from);
      }
    } finally {
      harness.service.close();
    }
  }, 60_000);
});
