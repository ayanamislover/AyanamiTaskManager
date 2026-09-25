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
   * atm_end 的 outcome 必须全小写，而旁边的 kind / importance / status / priority 全是大写。
   * 两个用 ATM 的 Agent 会话各自在同一处栽过：上一个调用刚教会它们大写枚举，下一个调用
   * 因为大写被拒。（别往回写成「唯一的小写枚举」：scope / view / operation 也是小写。）
   * 取值列在描述里，因为描述是所有客户端都会显示的那一行。
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
   * 回显本身也得从 max_chars 里出。头一版先扣掉回显开销、又把正文预算夹回下限，最后无条件
   * 把完整回显贴回响应：`max_chars=300` 配 30 个合法长度的越界字段，实际返回 1910 字符。
   * 靠 max_chars 控上下文的调用方没做错任何事，却拿回六倍于它要的量。
   */
  it("回显 ignored_fields 之后整个响应仍在调用方给的 max_chars 之内", async () => {
    const { project, call, raw, service } = await connect();
    const begun = await call("atm_begin", {
      project_code: project.code,
      mode: "project",
      agent_id: "codex",
      op_id: "budget-begin",
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
      op_id: "budget-plan",
      items: [{ client_ref: "t1", title: "任务", description: "长".repeat(4000) }],
    });
    const taskKey = String(
      created.entities.find((entity: Record<string, unknown>) => entity.entity_type === "WORK_ITEM")
        .key,
    );
    // 每个名字都在 schema 允许的 64 字符之内，条数也在上限之内——完全合法的请求。
    const unknown = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `unknown_${String(index).padStart(2, "0")}${"x".repeat(50)}`,
      );

    const got = await call("atm_task_get", {
      project: project.code,
      task_key: taskKey,
      max_chars: 300,
      field_mask: unknown(30),
    });
    expect(JSON.stringify(got).length).toBeLessThanOrEqual(300);
    // 列不下的名字换成计数，而不是默默少列几个。
    expect(got.ignored_fields_omitted).toBeGreaterThan(0);
    expect(got.ignored_fields.length + got.ignored_fields_omitted).toBe(30);

    const listed = await call("atm_task_list", {
      project: project.code,
      max_chars: 500,
      field_mask: unknown(20),
    });
    expect(JSON.stringify(listed).length).toBeLessThanOrEqual(500);
    expect(listed.ignored_fields.length + listed.ignored_fields_omitted).toBe(20);

    // 混着已知字段时，已知的那部分不能因为回显被挤掉。
    const mixed = await call("atm_task_get", {
      project: project.code,
      task_key: taskKey,
      max_chars: 300,
      field_mask: ["status", "version", ...unknown(28)],
    });
    expect(JSON.stringify(mixed).length).toBeLessThanOrEqual(300);
    expect(mixed.status).toBe("BACKLOG");

    // 只测最小预算不够：那时正文本来就小，离上限还远，「忘了从正文预算里扣掉回显」这种
    // 写法照样绿。要抓住它，得让正文真的顶到预算——full view 的长 description 会把
    // fitFieldRead 的档位一路撑满，此时多贴一段回显就必然溢出。
    for (const maxChars of [300, 700, 1200, 2000, 4000]) {
      const swept = await call("atm_task_get", {
        project: project.code,
        task_key: taskKey,
        view: "full",
        max_chars: maxChars,
        field_mask: ["description", ...unknown(20)],
      });
      expect(
        JSON.stringify(swept).length,
        `atm_task_get max_chars=${maxChars}`,
      ).toBeLessThanOrEqual(maxChars);
      // atm_task_list 的下限是 500，比 atm_task_get 高一档。
      const listMaxChars = Math.max(maxChars, 500);
      const sweptList = await raw("atm_task_list", {
        project: project.code,
        view: "full",
        max_chars: listMaxChars,
        field_mask: ["description", ...unknown(19)],
      });
      if (sweptList.isError) {
        expect(textOf(sweptList)).toContain("RESULT_TOO_LARGE");
        expect(textOf(sweptList)).toContain("increase_max_chars");
        expect(textOf(sweptList).length).toBeLessThanOrEqual(listMaxChars);
      } else {
        expect(
          JSON.stringify(sweptList.structuredContent).length,
          `atm_task_list max_chars=${listMaxChars}`,
        ).toBeLessThanOrEqual(listMaxChars);
      }
    }

    // continuation 这条路单独走 continueField，预算同样要算上回显。
    const fieldMask = ["description", ...unknown(20)];
    const first = await call("atm_task_get", {
      project: project.code,
      task_key: taskKey,
      view: "full",
      field_mask: fieldMask,
      max_chars: 2000,
    });
    const cursor = String(first.truncated_fields[0].continuation.cursor);
    const continued = await raw("atm_task_get", {
      project: project.code,
      task_key: taskKey,
      view: "full",
      field_mask: fieldMask,
      cursor,
      max_chars: 300,
    });
    if (continued.isError) {
      // 有界且照着做得了的报错也算合格；含糊地超发不算。
      expect(textOf(continued)).toContain("RESULT_TOO_LARGE");
    } else {
      expect(JSON.stringify(continued.structuredContent).length).toBeLessThanOrEqual(300);
    }
  });

  /**
   * 17 个 operation 的形状只活在 schema 的 oneOf 里，而不少客户端渲染 tools/list 时
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
