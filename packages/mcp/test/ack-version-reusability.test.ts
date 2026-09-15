import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { connectProfiledClients } from "./profile-client.js";

// ACK 契约承诺 entities[].version 可以直接当下一次的 expected_version。那条承诺只有在
// 回执报的是批次结束时的版本才成立：同一实体在一批里被连续操作（claim 让 v1→v2，
// start 接着 v2→v3）时若报中间值，调用方拿着 v2 去写必然撞版本冲突——而它并没有做错
// 任何事。所以这里不是断言某个具体数字，而是端到端验一遍那句承诺本身。

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as Record<string, any>;

describe("ACK 里的 version 能不能直接复用", () => {
  it("同实体在一批里被连续操作后，回执报的是批次最终版本", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-ack-version-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "ACK version",
      sourcePath: null,
      code: "ACKV",
    });
    const profiles = await connectProfiledClients(service, "ack-version");
    try {
      const session = String(
        structured(
          await profiles.coreClient.callTool({
            name: "atm_begin",
            arguments: {
              project_code: project.code,
              mode: "project",
              agent_id: "ack-version-agent",
              op_id: "ack-version-begin",
              brief: "none",
            },
          }),
        ).session,
      );
      const created = structured(
        await profiles.coreClient.callTool({
          name: "atm_task_create",
          arguments: {
            project: project.code,
            session,
            op_id: "ack-version-create",
            items: [{ client_ref: "t", title: "同实体连续操作", status: "READY" }],
          },
        }),
      );
      const taskKey = String(created.entities[0].key);
      expect(created.entities[0].version).toBe(1);

      // 一次调用里对同一个任务连做两步：claim 把 v1 推到 v2，start 再推到 v3。
      const patched = structured(
        await profiles.actionsClient.callTool({
          name: "atm_task_patch",
          arguments: {
            project: project.code,
            session,
            op_id: "ack-version-claim-start",
            items: [
              { operation: "claim", task_key: taskKey, expected_version: 1 },
              { operation: "start", task_key: taskKey, expected_version: 2 },
            ],
          },
        }),
      );
      expect(patched.ok).toBe(true);
      const acknowledged = patched.entities.find(
        (entity: Record<string, unknown>) => entity.key === taskKey,
      );
      expect(acknowledged).toBeDefined();

      const fetched = structured(
        await profiles.coreClient.callTool({
          name: "atm_task_get",
          arguments: { project: project.code, task_key: taskKey, view: "full" },
        }),
      );
      // 阳性对照：这一批真的推进了两级，否则下面只是在比两个相等的 v2。
      expect(fetched.version).toBe(3);
      expect(acknowledged.version).toBe(fetched.version);

      // 契约本身：拿 ACK 给的 version 直接写下一笔，不许冲突。
      const next = structured(
        await profiles.actionsClient.callTool({
          name: "atm_task_patch",
          arguments: {
            project: project.code,
            session,
            op_id: "ack-version-next-write",
            items: [
              {
                operation: "verify_and_complete",
                task_key: taskKey,
                expected_version: acknowledged.version,
              },
            ],
          },
        }),
      );
      expect(next.ok).toBe(true);
    } finally {
      await profiles.close();
      await service.close();
    }
  });
});
