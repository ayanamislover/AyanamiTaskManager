import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import {
  COMPLETION_GATE_REQUIRED_STATUSES,
  TASK_PATCH_OPERATION_NAMES,
} from "@ayanami-task/protocol";
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

async function connect() {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-error-text-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  services.push(service);
  const project = await service.createProject({ name: "报错文本", sourcePath: null, code: "ETXT" });
  const profiles = await connectProfiledClients(service, "error-text-test");
  connections.push(profiles.close);
  const raw = (name: string, args: Record<string, unknown>) =>
    profiles.client.callTool({ name, arguments: args });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await raw(name, args);
    if (response.isError) throw new Error(String((response.content as any)[0]?.text ?? ""));
    return response.structuredContent as Record<string, any>;
  };
  return {
    project,
    call,
    raw,
    service,
    actionsClient: profiles.actionsClient,
    coreClient: profiles.coreClient,
  };
}

const textOf = (response: { content: unknown }) =>
  String((response.content as Array<{ text?: unknown }>)[0]?.text ?? "");

describe("工具报错的正文要能照着做", () => {
  /**
   * 踩过的坑：对一批 READY 任务发 complete，拿回来的整句话就是
   * `COMPLETION_GATE_FAILED: WorkItem 尚未满足完成条件`。到底缺哪一条、现在该做什么，
   * 全在 structuredContent 里，而客户端根本不渲染那一段——只能靠猜「大概要先 start」。
   *
   * 而且当时那份 legal_operations 里还列着 complete 本身：一边说不能完成，一边说完成可用。
   */
  it("READY 任务被拒绝完成时，正文里写明还差什么、现在能做什么", async () => {
    const { project, call, raw, service } = await connect();
    const begun = await call("atm_begin", {
      project_code: project.code,
      mode: "project",
      agent_id: "codex",
      op_id: "error-text-begin",
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
      op_id: "error-text-plan",
      items: [
        {
          client_ref: "t1",
          title: "还没开工的任务",
          description: "",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          acceptance: [],
          checklist: [],
          verification_required: false,
          depends_on: [],
          depends_on_refs: [],
        },
      ],
    });
    const taskKey = String(
      created.entities.find((entity: Record<string, unknown>) => entity.entity_type === "WORK_ITEM")
        .key,
    );
    const detail = await call("atm_task_get", {
      project: project.code,
      task_key: taskKey,
      view: "core",
      field_mask: [],
    });

    const refused = await raw("atm_task_patch", {
      project: project.code,
      session,
      op_id: "error-text-complete",
      items: [{ task_key: taskKey, expected_version: detail.version, operation: "complete" }],
    });
    expect(refused.isError).toBe(true);
    const text = textOf(refused);
    expect(text).toContain("COMPLETION_GATE_FAILED");
    expect(text).toContain("CURRENT_STATE_INVALID");
    // 缺的是什么：当前 READY，闸门只认 IN_PROGRESS / VERIFYING。
    for (const status of COMPLETION_GATE_REQUIRED_STATUSES) expect(text).toContain(status);
    // 现在能做什么：start 在列，complete 不在——正被拒绝的操作不该再被推荐一次。
    expect(text).toContain("start -> IN_PROGRESS");
    expect(text).not.toContain("complete -> DONE");

    // 照着做一遍：先 start 再 complete，两步都成。
    const started = await call("atm_task_patch", {
      project: project.code,
      session,
      op_id: "error-text-start",
      items: [{ task_key: taskKey, expected_version: detail.version, operation: "start" }],
    });
    const version = Number(
      started.entities.find((entity: Record<string, unknown>) => entity.entity_type === "WORK_ITEM")
        .version,
    );
    const done = await call("atm_task_patch", {
      project: project.code,
      session,
      op_id: "error-text-complete-2",
      items: [{ task_key: taskKey, expected_version: version, operation: "complete" }],
    });
    expect(done.ok).toBe(true);
  });

  /**
   * atm_end 的 outcome 是整个 ATM 里唯一的小写枚举（kind / importance / status / priority
   * 全是大写）。两个用 ATM 的 Agent 会话各自在同一处栽过：上一个调用刚教会它们大写枚举，
   * 下一个调用因为大写被拒。取值列在描述里，因为描述是所有客户端都会显示的那一行。
   */
  it("atm_end 的描述点名 outcome 的每一个取值", async () => {
    const { coreClient } = await connect();
    const listed = await coreClient.listTools();
    const tool = listed.tools.find((each) => each.name === "atm_end");
    const values = ((tool?.inputSchema as any)?.properties?.outcome?.enum ?? []) as string[];
    expect(values).toContain("completed");
    for (const value of values) expect(tool?.description ?? "").toContain(value);
  });

  /**
   * field_mask 是「在 view 已有的字段内过滤」，不是「我要这些字段」。越界字段以前被静默丢掉，
   * 调用方看到的是「这个任务没有 title」，于是换 view 再 get 一次才发现是自己的 mask 越界。
   */
  it("field_mask 越界时回显 ignored_fields，而不是静默少给", async () => {
    const { project, call, service } = await connect();
    const begun = await call("atm_begin", {
      project_code: project.code,
      mode: "project",
      agent_id: "codex",
      op_id: "mask-begin",
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
      op_id: "mask-plan",
      items: [{ client_ref: "t1", title: "任务" }],
    });
    const taskKey = String(
      created.entities.find((entity: Record<string, unknown>) => entity.entity_type === "WORK_ITEM")
        .key,
    );

    // core view 有 status / version，没有 title / description。
    const got = await call("atm_task_get", {
      project: project.code,
      task_key: taskKey,
      field_mask: ["status", "version", "title", "description"],
    });
    expect(got).toMatchObject({ status: "BACKLOG" });
    expect(got.ignored_fields).toEqual(["title", "description"]);

    const listed = await call("atm_task_list", {
      project: project.code,
      field_mask: ["key", "status", "assignee_agent_id"],
    });
    expect(listed.ignored_fields).toEqual(["assignee_agent_id"]);

    // 没有越界时不该多出这个字段，免得每次响应都带一段噪音。
    const clean = await call("atm_task_get", {
      project: project.code,
      task_key: taskKey,
      field_mask: ["status", "version"],
    });
    expect(clean.ignored_fields).toBeUndefined();
  });

  /**
   * 16 个 operation 的形状只活在 schema 的 oneOf 里，而不少客户端渲染 tools/list 时
   * 把 oneOf/$defs 整段丢掉——调用方看到的 items 只剩 task_key 和 expected_version。
   * 描述是所有客户端都会显示的那行字，操作清单得写在那里。
   */
  it("atm_task_patch 的描述里点名每一个 operation", async () => {
    const { actionsClient } = await connect();
    const listed = await actionsClient.listTools();
    const description =
      listed.tools.find((tool) => tool.name === "atm_task_patch")?.description ?? "";
    expect(description).not.toBe("");
    for (const operation of TASK_PATCH_OPERATION_NAMES) expect(description).toContain(operation);
    for (const status of COMPLETION_GATE_REQUIRED_STATUSES) expect(description).toContain(status);
  });
});
