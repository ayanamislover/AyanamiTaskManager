import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { connectProfiledClients } from "./profile-client.js";

/**
 * checklist_single 与 checklist_batch 共用同一套 identity shape：`task_key` + `expected_version`
 * 字段名和类型完全一样，但 handler 把它们分派给了两个不同的比较器——single 落到
 * updateChecklist 比 `checklist_items.version`，batch 落到 updateChecklistBatch 比任务版本。
 *
 * 这个差异被文档写错过一次，而 schema 用例拦不住：`expected_version` 是任意非负整数，
 * 语义写反了照样 safeParse 通过。所以这里用真实 service 把两边的语义分别钉死。
 */
const roots: string[] = [];
const services: AyanamiTaskService[] = [];
const connections: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of connections.splice(0)) await close();
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

type Call = (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;

async function scenario(): Promise<{
  call: Call;
  project: string;
  session: string;
  taskKey: string;
  taskVersion: number;
  checklistId: string;
  checklistVersion: number;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-checklist-version-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  services.push(service);
  const project = await service.createProject({ name: "版本语义", sourcePath: null, code: "CLV" });
  const profiles = await connectProfiledClients(service, "checklist-version");
  connections.push(profiles.close);

  const call: Call = async (name, args) => {
    const response = await profiles.client.callTool({ name, arguments: args });
    if (response.isError) {
      throw new Error((response.content as Array<{ text?: string }>)[0]?.text ?? "");
    }
    return response.structuredContent as Record<string, any>;
  };

  const begun = await call("atm_begin", {
    project_code: project.code,
    mode: "project",
    agent_id: "version-probe",
  });
  const session = String(begun.session);
  await service.createObjective(project.code, session, {
    title: "目标",
    description: "",
    definitionOfDone: ["完成"],
  });
  const created = await call("atm_task_create", {
    project: project.code,
    session,
    op_id: "plan-1",
    items: [
      {
        client_ref: "t1",
        title: "带检查项的任务",
        description: "",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
        acceptance: ["做完"],
        checklist: [{ title: "第一项" }],
        depends_on: [],
        depends_on_refs: [],
      },
    ],
  });
  const taskKey = String(
    created.entities.find((entity: Record<string, unknown>) => entity.entity_type === "WORK_ITEM")
      .key,
  );

  // 先 start 一次，让任务版本和检查项版本分开——两者相同时这组用例证明不了任何事。
  const before = await call("atm_task_get", {
    project: project.code,
    task_key: taskKey,
    view: "full",
    field_mask: [],
  });
  await call("atm_task_patch", {
    project: project.code,
    session,
    op_id: "start-1",
    items: [
      {
        task_key: taskKey,
        expected_version: before.version,
        operation: "start",
        takeover_stale: false,
      },
    ],
  });
  const detail = await call("atm_task_get", {
    project: project.code,
    task_key: taskKey,
    view: "full",
    field_mask: [],
  });
  const checklistItem = detail.checklist[0];
  expect(detail.version).not.toBe(checklistItem.version);
  return {
    call,
    project: project.code,
    session,
    taskKey,
    taskVersion: Number(detail.version),
    checklistId: String(checklistItem.id),
    checklistVersion: Number(checklistItem.version),
  };
}

describe("checklist 操作的 expected_version 语义", () => {
  it("checklist_single 收的是检查项版本，传任务版本会冲突", async () => {
    const s = await scenario();
    const patch = (expectedVersion: number, opId: string) =>
      s.call("atm_task_patch", {
        project: s.project,
        session: s.session,
        op_id: opId,
        items: [
          {
            operation: "checklist_single",
            task_key: s.taskKey,
            expected_version: expectedVersion,
            checklist_items: [{ id: s.checklistId, status: "DONE" }],
          },
        ],
      });

    await expect(patch(s.taskVersion, "single-wrong")).rejects.toThrow(/VERSION_CONFLICT/u);
    const ok = await patch(s.checklistVersion, "single-right");
    expect(ok.ok).toBe(true);
  });

  it("checklist_single 传错 task_key 会被拒，不会静默改到别的任务上", async () => {
    const s = await scenario();
    // 另建一个任务，拿它的 key 去改前一个任务的检查项。
    const other = await s.call("atm_task_create", {
      project: s.project,
      session: s.session,
      op_id: "plan-2",
      items: [
        {
          client_ref: "t2",
          title: "另一个任务",
          description: "",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          acceptance: ["做完"],
          checklist: [],
          depends_on: [],
          depends_on_refs: [],
        },
      ],
    });
    const otherKey = String(
      other.entities.find((entity: Record<string, unknown>) => entity.entity_type === "WORK_ITEM")
        .key,
    );

    await expect(
      s.call("atm_task_patch", {
        project: s.project,
        session: s.session,
        op_id: "single-wrong-task",
        items: [
          {
            operation: "checklist_single",
            task_key: otherKey,
            expected_version: s.checklistVersion,
            checklist_items: [{ id: s.checklistId, status: "DONE" }],
          },
        ],
      }),
    ).rejects.toThrow(/CHECKLIST_TASK_MISMATCH/u);

    // 拒绝之后检查项必须原封不动——不能出现「报错了但已经改了」。
    const after = await s.call("atm_task_get", {
      project: s.project,
      task_key: s.taskKey,
      view: "full",
      field_mask: [],
    });
    expect(after.checklist[0].status).toBe("TODO");
    expect(after.checklist[0].version).toBe(s.checklistVersion);
  });

  it("checklist_batch 收的是任务版本，传检查项版本会冲突", async () => {
    const s = await scenario();
    const patch = (expectedVersion: number, opId: string) =>
      s.call("atm_task_patch", {
        project: s.project,
        session: s.session,
        op_id: opId,
        items: [
          {
            operation: "checklist_batch",
            task_key: s.taskKey,
            expected_version: expectedVersion,
            checklist_items: [{ id: s.checklistId, status: "DONE" }],
          },
        ],
      });

    // batch 的版本冲突不像 single 那样直接抛 VERSION_CONFLICT，而是收进整批失败原因里
    // 由闸门报出——错误码不同，但比对的确实是任务版本。
    await expect(patch(s.checklistVersion, "batch-wrong")).rejects.toThrow(/version conflict/iu);
    const ok = await patch(s.taskVersion, "batch-right");
    expect(ok.ok).toBe(true);
  });
});
