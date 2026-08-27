import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
const openServices: Array<{ close: () => void }> = [];
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

async function openHarness() {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-blocker-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  openServices.push(service);
  const project = await service.createProject({ name: "阻塞生命周期", sourcePath: null });
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

  const read = (taskKey: string) => service.getWorkItem(project.code, taskKey, "full");
  const patch = async (taskKey: string, input: Record<string, unknown>) => {
    const fresh = await read(taskKey);
    const result = await service.patchWorkItems(project.code, begun.session, nextId(), [
      { taskKey, expectedVersion: fresh.version, ...input } as never,
    ]);
    return result.items[0]!;
  };
  // 起一个已经开工、并且被带 blocker 的 progress 写过一次的任务。
  const blockedTask = async () => {
    const created = await service.createWorkItems(project.code, begun.session, nextId(), [
      {
        clientRef: `t-${counter}`,
        objectiveId: objective.id,
        title: "被阻塞的任务",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
      },
    ]);
    const key = created.items[0]!.key;
    await patch(key, { operation: "start" });
    await service.addProgress(project.code, begun.session, nextId(), {
      taskKey: key,
      percent: 30,
      summary: "等外部依赖，先停一下",
      completed: [],
      next: [],
      evidence: [],
      blocker: "等上游接口",
    });
    expect((await read(key)).status).toBe("BLOCKED");
    return key;
  };

  return { service, patch, read, blockedTask };
}

describe("blockers 记录必须能被关掉", () => {
  // blockers 是独立表，work_items.blocked_reason 只是影子。在此之前全仓库只有
  // 一处 INSERT 和一处闸门 SELECT：任务被带 blocker 的 progress 写过一次就
  // 永远完成不了，而清掉 blocked_reason 后界面上还看不出任何异常。
  it("带 blocker 的 progress 会挡住完成，reopen 之后放行", async () => {
    const harness = await openHarness();
    const key = await harness.blockedTask();
    await expect(harness.patch(key, { operation: "complete" })).rejects.toMatchObject({
      code: "COMPLETION_GATE_FAILED",
      details: {
        reasons: expect.arrayContaining([expect.objectContaining({ code: "BLOCKER_ACTIVE" })]),
      },
    });
    const reopened = await harness.patch(key, { operation: "reopen" });
    expect(reopened.status).toBe("IN_PROGRESS");
    const done = await harness.patch(key, { operation: "complete" });
    expect(done.status).toBe("DONE");
  }, 60_000);

  it("start 同样解除，覆盖任务已回到 IN_PROGRESS 却仍挂着 blocker 的情形", async () => {
    const harness = await openHarness();
    const key = await harness.blockedTask();
    const started = await harness.patch(key, { operation: "start" });
    expect(started.status).toBe("IN_PROGRESS");
    expect((await harness.read(key)).blockedReason).toBeNull();
    const done = await harness.patch(key, { operation: "complete" });
    expect(done.status).toBe("DONE");
  }, 60_000);

  // cancel 本身不关 blocker：blockers 表没有任何展示读取，cancel 侧的解除在
  // 公开接口上不可观测，写了也没有守卫能覆盖。真正解除的是重新排期后的 start，
  // 这条用例守的就是「取消过的任务重新捡起来不会被旧阻塞卡死」。
  it("取消后重新排期，start 会解除旧阻塞，任务不至于永久卡死", async () => {
    const harness = await openHarness();
    const key = await harness.blockedTask();
    expect((await harness.patch(key, { operation: "cancel" })).status).toBe("CANCELLED");
    expect((await harness.patch(key, { operation: "reopen" })).status).toBe("BACKLOG");
    expect((await harness.patch(key, { operation: "start" })).status).toBe("IN_PROGRESS");
    const done = await harness.patch(key, { operation: "complete" });
    expect(done.status).toBe("DONE");
  }, 60_000);
});
