import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { buildAyanamiServer } from "../src/index.js";

// 项目进度条只有四段：已完成 / 进行中 / 等你 / 可开始。
// 「已完成」只算本次 ATM 启动以来完成的任务：老项目的历史完成不计，否则已完成段越堆越长。

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-ui-strip-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  await service.createProject({ name: "进度条", sourcePath: null, code: "STRIP" });
  return { dataDir, service };
}

async function serve(service: AyanamiTaskService, startedAt?: string) {
  const app = await buildAyanamiServer({
    service,
    token: "strip-token",
    ...(startedAt === undefined ? {} : { startedAt }),
  });
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: "Bearer strip-token" },
      ...(payload ? { payload: payload as object } : {}),
    });
    expect([200, 201], response.body).toContain(response.statusCode);
    return response.json() as Record<string, any>;
  };
  return { app, call };
}

type Call = Awaited<ReturnType<typeof serve>>["call"];

async function move(call: Call, title: string, operations: Array<Record<string, unknown>>) {
  for (const step of operations) {
    const all = await call("GET", "/api/v1/projects/STRIP/ui/work-items?limit=100");
    const task = all.items.find((item: any) => item.title === title);
    await call("POST", "/api/v1/projects/STRIP/ui/work-items/patch", {
      opId: `strip-${String(step.operation)}-${task.key}`,
      items: [{ taskKey: task.key, expectedVersion: task.version, ...step }],
    });
  }
}

describe("项目进度条四段计数", () => {
  it("待整理/验收中/等待 Agent 算进行中，受阻与等待用户算等你，已完成只算启动之后", async () => {
    const { service } = await fixture();
    const first = await serve(service, "2000-01-01T00:00:00.000Z");
    let objectiveId = "";
    try {
      const objective = await first.call("POST", "/api/v1/projects/STRIP/ui/objectives", {
        opId: "strip-objective",
        title: "分组",
        description: "",
        definitionOfDone: [],
      });
      objectiveId = objective.id;
      const titles = {
        READY: "可开始",
        BACKLOG: "待整理",
        VERIFYING: "验收中",
        WAITING_AGENT: "等 Agent",
        WAITING_USER: "等用户",
        BLOCKED: "受阻",
        DONE_BEFORE: "上次启动完成",
        DONE_AFTER: "本次启动完成",
      };
      await first.call("POST", "/api/v1/projects/STRIP/ui/work-items", {
        opId: "strip-tasks",
        items: Object.entries(titles).map(([ref, title]) => ({
          clientRef: ref,
          objectiveId: objective.id,
          title,
          status: ref === "BACKLOG" ? "BACKLOG" : "READY",
          acceptance: [],
          checklist: [],
        })),
      });
      await move(first.call, titles.VERIFYING, [{ operation: "start" }, { operation: "verify" }]);
      await move(first.call, titles.WAITING_AGENT, [
        { operation: "start" },
        { operation: "wait_agent", waitingFor: "Agent 回话" },
      ]);
      await move(first.call, titles.WAITING_USER, [
        { operation: "start" },
        { operation: "wait_user", waitingFor: "用户确认" },
      ]);
      await move(first.call, titles.BLOCKED, [
        { operation: "start" },
        { operation: "block", blockedReason: "缺真机" },
      ]);
      await move(first.call, titles.DONE_BEFORE, [
        { operation: "start" },
        { operation: "complete" },
      ]);

      const before = await first.call("GET", "/api/v1/projects/STRIP/ui/progress-strip");
      expect(before).toEqual({
        since: "2000-01-01T00:00:00.000Z",
        done: 1,
        active: 3,
        waiting: 2,
        ready: 2,
      });
    } finally {
      await first.app.close();
    }

    // 「重启」：新的启动时间晚于上一条完成记录，上次完成的不再计入。
    const restartedAt = new Date(Date.now() + 1).toISOString();
    await new Promise((done) => setTimeout(done, 5));
    const second = await serve(service, restartedAt);
    try {
      const reset = await second.call("GET", "/api/v1/projects/STRIP/ui/progress-strip");
      expect(reset.done).toBe(0);
      await move(second.call, "本次启动完成", [{ operation: "start" }, { operation: "complete" }]);
      // 直接以已完成状态登记的任务没有 completed_at，和「最近结束」一样按最后更新时间算结束时间。
      await second.call("POST", "/api/v1/projects/STRIP/ui/work-items", {
        opId: "strip-recorded-done",
        items: [
          {
            clientRef: "recorded",
            objectiveId,
            title: "补登已完成",
            status: "DONE",
            acceptance: [],
            checklist: [],
          },
        ],
      });
      const after = await second.call("GET", "/api/v1/projects/STRIP/ui/progress-strip");
      expect(after).toEqual({ since: restartedAt, done: 2, active: 3, waiting: 2, ready: 1 });

      const status = await second.call("GET", "/api/v1/system/status");
      expect(status.startedAt).toBe(restartedAt);
    } finally {
      await second.app.close();
      service.close();
    }
  });

  it("不传启动时间时取构建服务器的那一刻", async () => {
    const { service } = await fixture();
    const before = Date.now();
    const { app, call } = await serve(service);
    try {
      const strip = await call("GET", "/api/v1/projects/STRIP/ui/progress-strip");
      expect(Date.parse(strip.since)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(strip.since)).toBeLessThanOrEqual(Date.now());
    } finally {
      await app.close();
      service.close();
    }
  });
});
