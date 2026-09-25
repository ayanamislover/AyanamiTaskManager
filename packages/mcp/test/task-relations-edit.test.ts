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

type Body = Record<string, any>;
type Relation = { type: string; direction: string; task_key: string };

// full 视图把关系放在 relations 里：本任务的前置是 BLOCKS/INCOMING，来源是 DISCOVERED_FROM/OUTGOING。
const dependenciesOf = (task: Body) =>
  (task.relations as Relation[])
    .filter((relation) => relation.type === "BLOCKS" && relation.direction === "INCOMING")
    .map((relation) => relation.task_key)
    .sort();
const originOf = (task: Body) =>
  (task.relations as Relation[]).find(
    (relation) => relation.type === "DISCOVERED_FROM" && relation.direction === "OUTGOING",
  )?.task_key ?? null;

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-task-relations-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  cleanups.push(() => service.close());
  const project = await service.createProject({ name: "关系补建", sourcePath: null, code: "REL" });
  const profiles = await connectProfiledClients(service, "task-relations-edit");
  cleanups.push(profiles.close);
  const call = async (name: string, args: Record<string, unknown>) =>
    profiles.client.callTool({ name, arguments: { project: project.code, ...args } });
  const ok = async (name: string, args: Record<string, unknown>) => {
    const response = await call(name, args);
    if (response.isError) throw new Error(JSON.stringify(response.content));
    return response.structuredContent as Body;
  };
  const begun = await profiles.coreClient.callTool({
    name: "atm_begin",
    arguments: {
      project_code: project.code,
      mode: "project",
      agent_id: "relations-agent",
      op_id: "rel-begin",
      brief: "none",
    },
  });
  const session = String((begun.structuredContent as Body).session);
  const created = await ok("atm_task_create", {
    session,
    op_id: "rel-create",
    items: [
      { client_ref: "a", title: "甲", status: "READY" },
      { client_ref: "b", title: "乙", status: "READY" },
      { client_ref: "c", title: "丙", status: "READY" },
      { client_ref: "d", title: "丁（待办）" },
    ],
  });
  const keys = created.entities.map((entity: { key: string }) => entity.key) as string[];
  let op = 0;
  const task = (key: string) => ok("atm_task_get", { task_key: key, view: "full" });
  const patch = async (item: Record<string, unknown>) =>
    call("atm_task_patch", {
      session,
      op_id: `rel-patch-${(op += 1)}`,
      items: [{ expected_version: (await task(String(item.task_key))).version, ...item }],
    });
  return { service, project, session, keys, ok, task, patch };
}

// ATM-T-0410：关系只能在 create 时一次写对，建完才想补就没路；BACKLOG→READY 也没有对应操作。
describe("建完之后补建 / 修改关系", () => {
  it("edit 的 depends_on / discovered_from 整组替换，规则与创建时一致", async () => {
    const { keys, task, patch } = await fixture();
    const [a, b, c] = keys as [string, string, string];

    const before = (await task(a)).version;
    const added = await patch({ task_key: a, operation: "edit", depends_on: [b, c] });
    expect(added.isError, JSON.stringify(added.content)).not.toBe(true);
    const afterAdd = await task(a);
    expect(dependenciesOf(afterAdd)).toEqual([b, c]);
    // 只改关系也要走版本号，否则并发改关系的两方谁也不会撞 VERSION_CONFLICT。
    expect(afterAdd.version).toBe(before + 1);

    // 前置未完成时不能开工——补上的依赖和创建时写的一样生效。
    const claim = await patch({ task_key: a, operation: "claim" });
    expect(claim.isError).toBe(true);
    expect(JSON.stringify(claim.content)).toContain("DEPENDENCY_NOT_READY");

    // 整组替换：只留 c。
    await patch({ task_key: a, operation: "edit", depends_on: [c] });
    expect(dependenciesOf(await task(a))).toEqual([c]);

    // 成环、依赖自身、重复引用都被拒，且不留下半截写入。
    const cycle = await patch({ task_key: c, operation: "edit", depends_on: [a] });
    expect(JSON.stringify(cycle.content)).toContain("DEPENDENCY_CYCLE");
    const self = await patch({ task_key: a, operation: "edit", depends_on: [a] });
    expect(JSON.stringify(self.content)).toContain("DEPENDENCY_CYCLE");
    const duplicate = await patch({ task_key: a, operation: "edit", depends_on: [b, b] });
    expect(JSON.stringify(duplicate.content)).toContain("VALIDATION_ERROR");
    expect(dependenciesOf(await task(c))).toEqual([]);
    expect(dependenciesOf(await task(a))).toEqual([c]);

    // 清空。
    await patch({ task_key: a, operation: "edit", depends_on: [] });
    expect(dependenciesOf(await task(a))).toEqual([]);

    // discovered_from：设置、改指向、解除；不能指向自身。
    await patch({ task_key: a, operation: "edit", discovered_from: b });
    expect(originOf(await task(a))).toBe(b);
    await patch({ task_key: a, operation: "edit", discovered_from: c });
    expect(originOf(await task(a))).toBe(c);
    const selfOrigin = await patch({ task_key: a, operation: "edit", discovered_from: a });
    // 数据库 CHECK 也会拒，但那是一条看不懂的约束失败；这里要的是可读的 self_reference。
    expect(JSON.stringify(selfOrigin.content)).toContain("self_reference");
    await patch({ task_key: a, operation: "edit", discovered_from: null });
    expect(originOf(await task(a))).toBeNull();

    // 关系变更不能走 expected_fields 的跨版本合并。
    const merged = await patch({
      task_key: a,
      operation: "edit",
      expected_fields: { title: "甲" },
      title: "甲'",
      depends_on: [b],
    });
    expect(merged.isError).toBe(true);
    expect(JSON.stringify(merged.content)).toContain("expectedVersion");
  });

  it("ready 把 BACKLOG 转为 READY，不留领取记录；其他状态拒绝", async () => {
    const { keys, task, patch, ok } = await fixture();
    const [a, , , d] = keys as [string, string, string, string];
    expect((await task(d)).status).toBe("BACKLOG");
    const readied = await patch({ task_key: d, operation: "ready" });
    expect(readied.isError, JSON.stringify(readied.content)).not.toBe(true);
    const after = await task(d);
    expect(after.status).toBe("READY");
    expect(after.claimed_by_session_id ?? null).toBeNull();
    expect(after.assignee_agent_id ?? null).toBeNull();

    // 进入 ready 列表。
    const ready = await ok("atm_task_list", { ready_only: true, limit: 20 });
    expect(JSON.stringify(ready)).toContain(d);

    const delta = await ok("atm_delta", { limit: 5 });
    expect(
      (delta.events as Array<{ type: string; key: string }>).some(
        (event) => event.type === "work.readied" && event.key === d,
      ),
    ).toBe(true);

    await patch({ task_key: a, operation: "start" });
    const wrong = await patch({ task_key: a, operation: "ready" });
    expect(wrong.isError).toBe(true);
    expect(JSON.stringify(wrong.content)).toContain("INVALID_TRANSITION");
  });

  it("挪到新父任务下时新父任务的聚合进度立即重算", async () => {
    const { service, project, session, keys, task, patch } = await fixture();
    const [, b, c] = keys as [string, string, string];
    await patch({ task_key: b, operation: "start" });
    await patch({ task_key: b, operation: "complete" });
    expect((await task(b)).status).toBe("DONE");
    const before = await service.getWorkItem(project.code, c, "full");
    void session;
    await patch({ task_key: b, operation: "edit", parent_key: c });
    const parent = await service.getWorkItem(project.code, c, "full");
    // 父任务自身未完成时聚合进度封顶 99；关键是挪入后立刻变化，而不是等下一次无关写入。
    expect(parent.progress).toBeGreaterThan(before.progress);
  });
});
