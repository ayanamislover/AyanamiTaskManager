import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { connectProfiledClients } from "./profile-client.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atm-knowledge-write-"));
  const service = await AyanamiTaskService.open({
    dataDir: root,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  const project = await service.createProject({
    name: "Knowledge writer",
    code: "KW",
    sourcePath: null,
  });
  await service.createProject({ name: "Other", code: "OTHER", sourcePath: null });
  const clients = await connectProfiledClients(service, "knowledge-writer");
  cleanup.push(async () => {
    await clients.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  });
  const begin = await clients.client.callTool({
    name: "atm_begin",
    arguments: { project_code: "KW", agent_id: "author", brief: "none" },
  });
  const session = String(begin.structuredContent!.session);
  const input = {
    project: "KW",
    session,
    op_id: "save-one",
    slug: "knowledge-writer",
    title: "可复用规则",
    summary: "使用条件与边界",
    body_markdown: "# 结论\n未经视觉实测的推导。",
    tags: ["test"],
    aliases: ["别名"],
    applies_to: ["v1"],
    use_when: "实现同类功能时",
    source_refs: [{ type: "manual", reference: "用户授权的知识整理" }],
  };
  const call = (args: Record<string, unknown>) =>
    clients.client.callTool({ name: "atm_knowledge_save", arguments: args });
  return { service, clients, input, call, project, session, root };
}

it("MCP 直接发布、按编辑视图更新；固定修订、作者身份与幂等回执持久保存", async () => {
  const f = await fixture();
  const saved = await f.call(f.input);
  expect(saved.isError).not.toBe(true);
  const entry = saved.structuredContent!;
  expect(entry).toMatchObject({
    ok: true,
    version: 1,
    publishedBy: {
      type: "AGENT",
      agentId: "author",
      projectId: f.project.id,
      sessionId: f.session,
    },
  });
  expect(entry.reference).toBe(`${entry.id}@${entry.revisionId}`);
  expect(entry).not.toHaveProperty("bodyMarkdown");
  expect(JSON.stringify(entry).length).toBeLessThan(1000);
  const read = await f.clients.client.callTool({
    name: "atm_knowledge_get",
    arguments: { id: entry.id, for_edit: true },
  });
  expect(read.structuredContent).toMatchObject({
    edit: { slug: f.input.slug, summary: f.input.summary, tags: ["test"], aliases: ["别名"] },
    appliesTo: ["v1"],
    bodyMarkdown: f.input.body_markdown,
  });
  const update = {
    ...f.input,
    op_id: "save-two",
    id: entry.id,
    expected_revision_id: entry.revisionId,
    body_markdown: "# 新结论\n已测试。",
  };
  const changed = await f.call(update);
  expect(changed.isError).not.toBe(true);
  expect(changed.structuredContent).toMatchObject({ version: 2 });
  expect((await f.call(f.input)).structuredContent).toEqual(entry);
  expect((await f.call(update)).structuredContent).toEqual(changed.structuredContent);
  expect((await f.call({ ...update, op_id: "stale" })).isError).toBe(true);
  expect((await f.call({ ...f.input, title: "reuse wrong payload" })).isError).toBe(true);
  expect((await f.call({ ...f.input, op_id: "duplicate-slug" })).isError).toBe(true);
  expect((await f.service.knowledge.history(String(entry.id))).revisions).toHaveLength(2);
  expect(
    await f.service.knowledge.get({ id: String(entry.id), revisionId: String(entry.revisionId) }),
  ).toMatchObject({ bodyMarkdown: f.input.body_markdown, publishedBy: entry.publishedBy });
});

it("缺失或外项目 Session、伪造作者、错误更新基线、NUL、归档条目和结束会话均不能写入", async () => {
  const f = await fixture();
  for (const patch of [
    { session: "missing" },
    { project: "OTHER" },
    { actor: "USER" },
    { published_by: { type: "USER" } },
    { id: "missing" },
    { expected_revision_id: "unpaired" },
    { body_markdown: "bad\0body" },
  ])
    expect((await f.call({ ...f.input, ...patch })).isError).toBe(true);
  expect((await f.service.knowledge.search()).hits).toHaveLength(0);
  const saved = (await f.call(f.input)).structuredContent!;
  await f.service.knowledge.archive({
    id: String(saved.id),
    opId: "archive",
    expectedVersion: 1,
    expectedRevisionId: String(saved.revisionId),
    archived: true,
  });
  expect(
    (
      await f.call({
        ...f.input,
        op_id: "archived-write",
        id: saved.id,
        expected_revision_id: saved.revisionId,
      })
    ).isError,
  ).toBe(true);
  await f.clients.client.callTool({
    name: "atm_end",
    arguments: {
      project: "KW",
      session: f.session,
      op_id: "end",
      outcome: "completed",
      summary: "done",
    },
  });
  expect((await f.call({ ...f.input, op_id: "closed-write", slug: "new-entry" })).isError).toBe(
    true,
  );
  expect((await f.service.knowledge.history(String(saved.id))).revisions).toHaveLength(1);
});

it("同一修订并发更新只允许一个成功，不覆盖胜者", async () => {
  const f = await fixture();
  const entry = (await f.call(f.input)).structuredContent!;
  const results = await Promise.all(
    ["a", "b"].map((label) =>
      f.call({
        ...f.input,
        id: entry.id,
        expected_revision_id: entry.revisionId,
        op_id: label,
        body_markdown: label,
      }),
    ),
  );
  expect(results.filter((result) => !result.isError)).toHaveLength(1);
  expect(results.filter((result) => result.isError)).toHaveLength(1);
  expect((await f.service.knowledge.history(String(entry.id))).revisions).toHaveLength(2);
});

it("关闭会话后仅允许原载荷回放，不复活Session或增加修订", async () => {
  const f = await fixture();
  const saved = (await f.call(f.input)).structuredContent!;
  await f.clients.client.callTool({
    name: "atm_end",
    arguments: {
      project: "KW",
      session: f.session,
      op_id: "close-before-replay",
      outcome: "completed",
      summary: "done",
    },
  });
  const before = await f.service.knowledge.history(String(saved.id));
  const replay = await f.call(f.input);
  expect(replay.isError).not.toBe(true);
  expect(replay.structuredContent).toEqual(saved);
  expect(JSON.stringify(await f.call({ ...f.input, title: "different payload" }))).toContain(
    "IDEMPOTENCY_CONFLICT",
  );
  expect((await f.call({ ...f.input, op_id: "new-closed-operation", slug: "new" })).isError).toBe(
    true,
  );
  expect(await f.service.knowledge.history(String(saved.id))).toEqual(before);
  expect((await f.service.getSession("KW", f.session)).connectionState).toBe("CLOSED");
});

it("知识事务提交回执失败时连同正文与索引一起回滚，修复后可重试", async () => {
  const f = await fixture();
  const db = (await f.service.databases.knowledge.open()).database.sqlite;
  db.exec(
    "CREATE TRIGGER reject_receipt BEFORE INSERT ON knowledge_operations BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END",
  );
  expect((await f.call(f.input)).isError).toBe(true);
  expect(db.prepare("SELECT count(*) AS count FROM knowledge_entries").get()).toEqual({ count: 0 });
  expect(db.prepare("SELECT count(*) AS count FROM knowledge_revisions").get()).toEqual({
    count: 0,
  });
  expect((await f.service.knowledge.search()).hits).toHaveLength(0);
  db.exec("DROP TRIGGER reject_receipt");
  expect((await f.call(f.input)).structuredContent).toMatchObject({ ok: true, version: 1 });
});

it("重启后原会话的发布回执与作者仍可恢复，其他会话同 op_id 不会重放旧作者结果", async () => {
  const f = await fixture();
  const saved = (await f.call(f.input)).structuredContent!;
  await f.clients.client.callTool({
    name: "atm_end",
    arguments: {
      project: "KW",
      session: f.session,
      op_id: "close-before-restart",
      outcome: "completed",
      summary: "closed",
    },
  });
  await f.clients.close();
  f.service.close();
  const reopened = await AyanamiTaskService.open({
    dataDir: f.root,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  const clients = await connectProfiledClients(reopened, "knowledge-restart");
  cleanup.unshift(async () => {
    await clients.close();
    reopened.close();
  });
  const replay = await clients.client.callTool({ name: "atm_knowledge_save", arguments: f.input });
  expect(replay.structuredContent).toEqual(saved);
  const begun = await clients.client.callTool({
    name: "atm_begin",
    arguments: { project_code: "KW", agent_id: "another-author", brief: "none" },
  });
  const other = await clients.client.callTool({
    name: "atm_knowledge_save",
    arguments: { ...f.input, session: begun.structuredContent!.session, slug: "other-entry" },
  });
  expect(other.isError).not.toBe(true);
  expect(other.structuredContent!.id).not.toBe(saved.id);
  expect(other.structuredContent!.publishedBy).toMatchObject({ agentId: "another-author" });
});
