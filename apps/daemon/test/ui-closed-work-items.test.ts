import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { buildAyanamiServer } from "../src/index.js";

// 桌面端任务列表默认只拉未结束的任务，已结束的走 /ui/work-items/closed 按需加载。
// 这里验证 HTTP 接线：closed 参数真的传到了存储层，静态段 closed 没被 /:taskKey 抢先匹配。

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

describe("UI 已结束任务分组路由", () => {
  it("closed=0 只返回未结束任务，/closed 按结束时间倒序并附带总数", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-ui-closed-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "closed-token" });
    const headers = { authorization: "Bearer closed-token" };
    const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
      const response = await app.inject({
        method,
        url,
        headers,
        ...(payload ? { payload: payload as object } : {}),
      });
      expect([200, 201], response.body).toContain(response.statusCode);
      return response.json() as Record<string, any>;
    };
    try {
      await service.createProject({ name: "分组路由", sourcePath: null, code: "UIC" });
      const objective = await call("POST", "/api/v1/projects/UIC/ui/objectives", {
        opId: "uic-objective",
        title: "分组",
        description: "",
        definitionOfDone: [],
      });
      await call("POST", "/api/v1/projects/UIC/ui/work-items", {
        opId: "uic-tasks",
        items: ["保持打开", "先完成", "后完成"].map((title, index) => ({
          clientRef: `task-${index}`,
          objectiveId: objective.id,
          title,
          status: "READY",
          acceptance: [],
          checklist: [],
        })),
      });
      const all = await call("GET", "/api/v1/projects/UIC/ui/work-items?limit=100");
      const byTitle = new Map<string, any>(all.items.map((task: any) => [task.title, task]));
      for (const title of ["先完成", "后完成"]) {
        let task = byTitle.get(title);
        for (const operation of ["start", "complete"]) {
          const result = await call("POST", "/api/v1/projects/UIC/ui/work-items/patch", {
            opId: `uic-${operation}-${task.key}`,
            items: [{ taskKey: task.key, expectedVersion: task.version, operation }],
          });
          expect(result).toBeTruthy();
          const fresh = await call("GET", "/api/v1/projects/UIC/ui/work-items?limit=100");
          task = fresh.items.find((item: any) => item.key === task.key);
        }
      }

      const open = await call("GET", "/api/v1/projects/UIC/ui/work-items?limit=100&closed=0");
      expect(open.items.map((task: any) => task.title)).toEqual(["保持打开"]);

      const closed = await call("GET", "/api/v1/projects/UIC/ui/work-items/closed?limit=1");
      expect(closed.total).toBe(2);
      expect(closed.hasMore).toBe(true);
      expect(closed.items).toHaveLength(1);
      expect(closed.items[0].title).toBe("后完成");
      const rest = await call(
        "GET",
        `/api/v1/projects/UIC/ui/work-items/closed?limit=5&cursor=${encodeURIComponent(closed.nextCursor)}`,
      );
      expect(rest.items.map((task: any) => task.title)).toEqual(["先完成"]);
      expect(rest.hasMore).toBe(false);
    } finally {
      await app.close();
      service.close();
    }
  });
});
