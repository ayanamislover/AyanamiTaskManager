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
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

async function connect(name: string, code: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-planning-root-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  services.push(service);
  // 只建项目，不建 objective——这正是纯 MCP 会话拿到的起点。
  const project = await service.createProject({ name, sourcePath: null, code });
  const profiles = await connectProfiledClients(service, "planning-root-test");
  connections.push(profiles.close);

  const call = async (tool: string, args: Record<string, unknown>) => {
    const response = await profiles.client.callTool({ name: tool, arguments: args });
    if (response.isError) {
      throw new Error((response.content as Array<{ text?: string }>)[0]?.text ?? "");
    }
    return response.structuredContent as Record<string, any>;
  };
  return { project, call, service };
}

describe("纯 MCP 会话的规划根", () => {
  // 建 objective 只有 REST 入口，MCP 十二个工具里一个都没有；而 atm_task_create
  // 在项目没有活动 objective 时直接抛 OBJECTIVE_REQUIRED。两条合起来的后果是：
  // 一个只有 MCP 的 Agent 在刚建好的项目里，一个任务也建不出来，整条链断在起点。
  it("在没有 objective 的新项目里能把任务从建立走到 DONE", async () => {
    const { project, call, service } = await connect("规划根", "PROOT");
    expect(await service.listObjectives(project.code)).toHaveLength(0);

    const begun = await call("atm_begin", {
      project_code: project.code,
      mode: "project",
      agent_id: "codex",
      role: "PRIMARY",
      resume: false,
      allow_project_create: false,
    });
    const session = String(begun.session);

    const created = await call("atm_task_create", {
      project: project.code,
      session,
      op_id: "planning-root-create",
      items: [
        {
          client_ref: "first",
          title: "新项目的第一个任务",
          description: "验证纯 MCP 会话不需要先有 objective",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          depends_on: [],
          depends_on_refs: [],
          acceptance: [],
          checklist: [],
          verification_required: false,
        },
      ],
    });
    // 固定 ACK 只保留实体预览；完整规划决策进入 durable operation receipt。
    const creationTrace = await call("atm_search", {
      project: project.code,
      op_id: "planning-root-create",
      session,
      max_chars: 20_000,
    });
    expect(creationTrace.operation.mutations[0].response.planningRootProvisioned).toBe(true);
    const taskEntity = created.entities.find(
      (entity: Record<string, unknown>) => entity.entity_type === "WORK_ITEM",
    );
    const taskKey = String(taskEntity.key);

    let version = Number(taskEntity.version);
    for (const operation of ["claim", "start", "complete"]) {
      const patched = await call("atm_task_patch", {
        project: project.code,
        session,
        op_id: `planning-root-${operation}`,
        items: [{ task_key: taskKey, expected_version: version, operation, takeover_stale: false }],
      });
      version = Number(
        patched.entities.find(
          (entity: Record<string, unknown>) => entity.entity_type === "WORK_ITEM",
        ).version,
      );
    }
    const done = await service.getWorkItem(project.code, taskKey, "core");
    expect((done as Record<string, unknown>).status).toBe("DONE");

    // 补建的目标必须一眼看出是机器定的，否则事后没人分得清是谁规划的。
    const objectives = await service.listObjectives(project.code);
    expect(objectives).toHaveLength(1);
    expect(String((objectives[0] as Record<string, unknown>).title)).toBe("规划根（自动补建）");

    // 第二次不能再补一个：只在确实没有规划根时才动手。
    const again = await call("atm_task_create", {
      project: project.code,
      session,
      op_id: "planning-root-create-again",
      items: [
        {
          client_ref: "second",
          title: "第二个任务",
          description: "复用已有规划根",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          depends_on: [],
          depends_on_refs: [],
          acceptance: [],
          checklist: [],
          verification_required: false,
        },
      ],
    });
    const secondTrace = await call("atm_search", {
      project: project.code,
      op_id: "planning-root-create-again",
      session,
      max_chars: 20_000,
    });
    expect(again.entities).toHaveLength(1);
    expect(secondTrace.operation.mutations[0].response.planningRootProvisioned).toBe(false);
    expect(await service.listObjectives(project.code)).toHaveLength(1);
  }, 30_000);

  // 阳性对照：已经规划好的项目不能因为这条路径凭空多出一个目标。
  it("项目已有目标时不补建，也不改变归属", async () => {
    const { project, call, service } = await connect("已规划", "PLAN2");
    const objective = await service.createObjectiveAsUser(project.code, "human-objective", {
      title: "人定的目标",
      description: "",
      definitionOfDone: [],
    });
    expect(await service.listObjectives(project.code)).toHaveLength(1);

    const begun = await call("atm_begin", {
      project_code: project.code,
      mode: "project",
      agent_id: "codex",
      role: "PRIMARY",
      resume: false,
      allow_project_create: false,
    });
    const created = await call("atm_task_create", {
      project: project.code,
      session: String(begun.session),
      op_id: "planning-root-existing",
      items: [
        {
          client_ref: "only",
          title: "落在人定目标下",
          description: "",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          depends_on: [],
          depends_on_refs: [],
          acceptance: [],
          checklist: [],
          verification_required: false,
        },
      ],
    });
    expect(created.entities).toHaveLength(1);
    const objectives = await service.listObjectives(project.code);
    expect(objectives).toHaveLength(1);
    expect(String((objectives[0] as Record<string, unknown>).id)).toBe(String(objective.id));
    // 目标是人定的，但里程碑仍要补出来，否则任务没有落位——这一步是静默的，
    // 所以更要有断言盯着，不能只靠回执为空来推断它没发生。
    const milestones = await service.listMilestones(project.code, String(objective.id));
    expect(milestones).toHaveLength(1);
    expect(String((milestones[0] as Record<string, unknown>).title)).toBe("执行");
  }, 30_000);
});
