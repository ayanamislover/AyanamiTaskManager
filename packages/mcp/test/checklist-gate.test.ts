import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];
const services: AyanamiTaskService[] = [];
const connections: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of connections.splice(0)) await close();
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function connect() {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-gate-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  services.push(service);
  // 建项目没有 MCP 工具，只能在这里搭台。objective 已经不用管了：项目没有活动
  // 目标时 atm_task_create 会自己补规划根（见 planning-root.test.ts）。本用例要
  // 守的是「有了台子之后，检查项闸门能不能靠工具穿过去」。
  const project = await service.createProject({ name: "闸门", sourcePath: null, code: "GATE" });
  const profiles = await connectProfiledClients(service, "gate-test");
  connections.push(profiles.close);

  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await profiles.client.callTool({ name, arguments: args });
    if (response.isError) {
      const text = (response.content as Array<{ text?: string }>)[0]?.text ?? "";
      throw new Error(text);
    }
    return response.structuredContent as Record<string, any>;
  };
  return { project, call, service };
}

describe("只用 MCP 工具就能穿过检查项闸门", () => {
  it("从 begin 到 DONE 全程只调工具，中途给必证检查项挂上证据", async () => {
    const { project, call, service } = await connect();
    const begun = await call("atm_begin", {
      project_code: project.code,
      mode: "project",
      agent_id: "codex",
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
          title: "需要证据的任务",
          description: "",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          acceptance: ["做完"],
          checklist: [{ title: "必须留证", evidence_required: true }],
          verification_required: true,
          depends_on: [],
          depends_on_refs: [],
        },
      ],
    });
    const taskKey = String(created.created[0].task_key);

    const detail = await call("atm_task_get", {
      project: project.code,
      task_key: taskKey,
      view: "context",
      field_mask: [],
    });
    const item = detail.checklist[0];
    expect(item.evidenceRequired).toBe(true);

    await call("atm_task_patch", {
      project: project.code,
      session,
      op_id: "start-1",
      items: [
        {
          task_key: taskKey,
          expected_version: detail.version,
          operation: "start",
          takeover_stale: false,
        },
      ],
    });

    // 必证项没有证据时，闸门必须拦下——工具存在不等于闸门失效。
    await expect(
      call("atm_task_patch", {
        project: project.code,
        session,
        op_id: "tick-empty",
        items: [
          {
            task_key: taskKey,
            operation: "checklist_single",
            expected_version: item.version,
            checklist_items: [{ id: item.id, status: "DONE", evidence: [] }],
          },
        ],
      }),
    ).rejects.toThrow(/evidence required/u);

    const ticked = await call("atm_task_patch", {
      project: project.code,
      session,
      op_id: "tick-1",
      items: [
        {
          task_key: taskKey,
          operation: "checklist_single",
          expected_version: item.version,
          checklist_items: [{ id: item.id, status: "DONE", evidence: ["pnpm test 53 文件全绿"] }],
        },
      ],
    });
    expect(ticked.status).toBe("DONE");
    expect(ticked.evidence).toBe(1);

    await call("atm_task_patch", {
      project: project.code,
      session,
      op_id: "verify-1",
      items: [
        {
          task_key: taskKey,
          expected_version: ticked.task_version,
          operation: "verify",
          takeover_stale: false,
        },
      ],
    });
    const fresh = await call("atm_task_get", {
      project: project.code,
      task_key: taskKey,
      view: "core",
      field_mask: [],
    });
    const done = await call("atm_task_patch", {
      project: project.code,
      session,
      op_id: "done-1",
      items: [
        {
          task_key: taskKey,
          expected_version: fresh.version,
          operation: "complete",
          takeover_stale: false,
        },
      ],
    });
    expect(done.items[0].status).toBe("DONE");
  }, 60_000);

  it("跳过必证项同样是一条出路，不必伪造证据", async () => {
    const { project, call, service } = await connect();
    const begun = await call("atm_begin", {
      project_code: project.code,
      mode: "project",
      agent_id: "codex",
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
      op_id: "plan-2",
      items: [
        {
          client_ref: "t2",
          title: "这项其实不适用",
          description: "",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          acceptance: ["做完"],
          checklist: [{ title: "不适用的必证项", evidence_required: true }],
          verification_required: false,
          depends_on: [],
          depends_on_refs: [],
        },
      ],
    });
    const taskKey = String(created.created[0].task_key);
    const detail = await call("atm_task_get", {
      project: project.code,
      task_key: taskKey,
      view: "context",
      field_mask: [],
    });
    await call("atm_task_patch", {
      project: project.code,
      session,
      op_id: "start-2",
      items: [
        {
          task_key: taskKey,
          expected_version: detail.version,
          operation: "start",
          takeover_stale: false,
        },
      ],
    });
    const skipped = await call("atm_task_patch", {
      project: project.code,
      session,
      op_id: "skip-1",
      items: [
        {
          task_key: taskKey,
          operation: "checklist_single",
          expected_version: detail.checklist[0].version,
          checklist_items: [{ id: detail.checklist[0].id, status: "SKIPPED" }],
        },
      ],
    });
    expect(skipped.status).toBe("SKIPPED");
    const done = await call("atm_task_patch", {
      project: project.code,
      session,
      op_id: "done-2",
      items: [
        {
          task_key: taskKey,
          expected_version: skipped.task_version,
          operation: "complete",
          takeover_stale: false,
        },
      ],
    });
    expect(done.items[0].status).toBe("DONE");
  }, 60_000);
});
