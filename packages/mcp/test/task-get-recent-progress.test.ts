import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

function structured(result: { isError?: unknown; content: unknown; structuredContent?: unknown }) {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as Record<string, any>;
}

// ATM-T-0409：task_get 只给 description / acceptance / checklist，看进度得另搜一次，
// 于是跨 Session 恢复靠的是会话自己的压缩摘要而不是 ATM。
describe("atm_task_get last_progress", () => {
  it("点名时附带本任务最近 N 条进度，新的在前；不点名时不多一个字节", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-task-get-progress-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    cleanups.push(() => service.close());
    const project = await service.createProject({
      name: "任务进度",
      sourcePath: null,
      code: "TGP",
    });
    const profiles = await connectProfiledClients(service, "task-get-progress");
    cleanups.push(profiles.close);
    const session = String(
      structured(
        await profiles.coreClient.callTool({
          name: "atm_begin",
          arguments: {
            project_code: project.code,
            mode: "project",
            agent_id: "task-get-progress-agent",
            op_id: "tgp-begin",
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
          op_id: "tgp-create",
          items: [
            { client_ref: "a", title: "目标任务", status: "READY", description: "长".repeat(3000) },
            { client_ref: "b", title: "旁边的任务", status: "READY" },
          ],
        },
      }),
    );
    const [target, other] = created.entities.map((entity: { key: string }) => entity.key);

    // 两个任务的进度交替写入，确认只取本任务的。
    for (let index = 0; index < 4; index += 1) {
      for (const [key, label] of [
        [target, "目标"],
        [other, "旁边"],
      ] as const) {
        await profiles.memoryClient.callTool({
          name: "atm_progress_add",
          arguments: {
            project: project.code,
            session,
            op_id: `tgp-progress-${label}-${index}`,
            scope: "task",
            task_key: key,
            summary: `${label}进度 ${index}`,
          },
        });
      }
    }

    const get = async (args: Record<string, unknown>) =>
      structured(
        await profiles.coreClient.callTool({
          name: "atm_task_get",
          arguments: { project: project.code, task_key: target, ...args },
        }),
      );

    const withProgress = await get({ last_progress: 3 });
    expect(
      withProgress.recent_progress.map((progress: { summary: string }) => progress.summary),
    ).toEqual(["目标进度 3", "目标进度 2", "目标进度 1"]);
    for (const progress of withProgress.recent_progress) {
      expect(progress).not.toHaveProperty("task_key");
      expect(progress.id).toEqual(expect.any(String));
    }

    const plainGet = await get({});
    expect(plainGet).not.toHaveProperty("recent_progress");
    const { recent_progress: _recent, ...rest } = withProgress;
    void _recent;
    expect(rest).toEqual(plainGet);

    // field_mask 管的是 view 字段；点名要的进度不会被它滤掉，也不算越界字段。
    const masked = await get({ last_progress: 1, field_mask: ["key", "status"] });
    expect(Object.keys(masked).sort()).toEqual(["key", "recent_progress", "status"]);
    expect(masked.recent_progress).toHaveLength(1);

    // 续读游标绑定 last_progress：换了 N 再拿同一个游标续读必须被拒。
    const tight = await get({
      last_progress: 1,
      view: "full",
      field_mask: ["key", "description"],
      max_chars: 1200,
    });
    const cursor = tight.truncated_fields?.[0]?.continuation?.cursor;
    expect(cursor, JSON.stringify(tight).slice(0, 400)).toEqual(expect.any(String));
    // 续读页只返回被续读的字段本身。
    await get({
      last_progress: 1,
      view: "full",
      field_mask: ["key", "description"],
      max_chars: 1200,
      cursor,
    });
    const mismatched = await profiles.coreClient.callTool({
      name: "atm_task_get",
      arguments: {
        project: project.code,
        task_key: target,
        view: "full",
        field_mask: ["key", "description"],
        max_chars: 1200,
        last_progress: 2,
        cursor,
      },
    });
    expect(mismatched.isError).toBe(true);
  });
});
