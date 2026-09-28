import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { authenticate, buildAyanamiServer, type AtmRouteEntry } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const AGENT = "agent-token-from-daemon-json";
const USER = "user-token-held-in-main-process";
const routeSources = join(process.cwd(), "apps", "daemon", "src");

type RouteBlock = { file: string; method: string; path: string; text: string };

/** 按 `app.<method>("path"` 把路由文件切成块，块从注册处一直到下一条注册。 */
function routeBlocks(files: Array<{ file: string; text: string }>): RouteBlock[] {
  const pattern = /app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gu;
  return files.flatMap(({ file, text }) => {
    const starts = [...text.matchAll(pattern)];
    return starts.map((match, index) => ({
      file,
      method: match[1]!.toUpperCase(),
      path: match[2]!,
      text: text.slice(match.index, starts[index + 1]?.index ?? text.length),
    }));
  });
}

/** 处理器里以用户身份落账，或做的是只该由用户做的决定。 */
const USER_IDENTITY =
  /"USER"|AsUser\(|userActor\(|\.(?:decideProjectRestoreRequest|restoreProject|trashProject|archiveProject|restoreBackup|applyAgentTaskImport|attachProjectPath|setSetting)\(/u;

function unguardedUserRoutes(blocks: RouteBlock[]): string[] {
  return blocks
    .filter((block) => USER_IDENTITY.test(block.text))
    .filter((block) => !/^app\.\w+\(\s*"[^"]+",\s*USER_ONLY,/u.test(block.text))
    .filter((block) => !/\bassert(?:User|QuickTaskActor)\(request/u.test(block.text))
    .map((block) => `${block.file} ${block.method} ${block.path}`);
}

function sourceFiles() {
  return readdirSync(routeSources)
    .filter((name) => name.endsWith("-routes.ts"))
    .map((file) => ({ file, text: readFileSync(join(routeSources, file), "utf8") }));
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Agent 凭证可以调的写路由，每条都要写明为什么（ATM-T-0506）。
 * 新增写路由若既没标 USER_ONLY、也不在这里，守卫就红：默认没有「顺手开放」。
 */
const AGENT_WRITES: Record<string, string> = {
  // 理由必须写实际行为，而不是「看起来无害」（ATM-T-0508：备份曾被写成「只新增」）。
  "POST /mcp": "MCP 传输入口；实际能做什么由工具契约决定，工具面另有守卫，不含恢复/授权",
  "POST /mcp/core": "MCP 传输入口（core profile）",
  "POST /mcp/memory": "MCP 传输入口（memory profile）",
  "POST /mcp/actions": "MCP 传输入口（actions profile）",
  "DELETE /mcp": "已注册但固定返回 405（无状态 MCP 传输），不产生写入",
  "DELETE /mcp/core": "已注册但固定返回 405，不产生写入",
  "DELETE /mcp/memory": "已注册但固定返回 405，不产生写入",
  "DELETE /mcp/actions": "已注册但固定返回 405，不产生写入",
  "POST /api/v1/sessions": "Agent 开工（begin）；撞上垃圾箱项目只登记恢复请求",
  "POST /api/v1/sessions/:id/close":
    "Agent 收工（end）：按 id 结束 Session 并释放其领取，id 可以是别的 Agent 的 Session（与 MCP atm_end 同一能力）",
  "POST /api/v1/projects":
    "登记新受管项目（自动建项目的既定授权）；带 sourcePath 时还会写 .ayanami-task/project.json 与 Git exclude；目录已被绑定则拒绝，不接管已有项目",
  "POST /api/v1/projects/:code/objectives":
    "指南让 Agent 走 REST 再建 Objective；需有效 Agent session",
  "POST /api/v1/projects/:code/milestones":
    "指南让 Agent 走 REST 再建 Milestone；需有效 Agent session",
  "POST /api/v1/projects/:code/work-items": "Agent 任务流；需有效 Agent session，session=USER 被拒",
  "POST /api/v1/projects/:code/work-items/patch": "Agent 任务流；受 session/op/版本约束",
  "POST /api/v1/projects/:code/work-items/:taskKey/verify-and-complete":
    "Agent 任务流；受完成闸门约束",
  "POST /api/v1/projects/:code/reviews/requests": "Agent 发起复核；候选绑定在服务层校验",
  "POST /api/v1/projects/:code/reviews/requests/:requestKey/submit":
    "Agent 提交复核结论；reviewer 身份在服务层校验",
  "PATCH /api/v1/projects/:code/checklist/batch": "Agent 检查项工作流；版本与归属在服务层校验",
  "PATCH /api/v1/projects/:code/checklist/:id": "Agent 检查项工作流；版本与归属在服务层校验",
  "POST /api/v1/projects/:code/progress-updates":
    "与 MCP atm_progress_add 同一写入面；需有效 session",
  "POST /api/v1/projects/:code/records":
    "与 MCP atm_record 同一写入面；需有效 session，session=USER 被拒",
  "POST /api/v1/quick-tasks": "落账 actor 不能冒用 USER（缺省即 USER，需用户凭证）；不校验任务归属",
  "PATCH /api/v1/quick-tasks/:id":
    "同上：只挡 actor=USER；Agent 以自己的 actor 仍能改用户建的临时任务",
  "POST /api/v1/quick-tasks/:id/promote": "同上：只挡 actor=USER，不校验任务归属",
  "POST /api/v1/imports/agenttask-md/preview": "只解析并返回预览，不调用 apply、不落账",
  "POST /api/v1/projects/:code/projection/reconcile":
    "重放投影 outbox，修复派生读模型，不改项目事实；可能耗时",
  "POST /api/v1/system/projections/reconcile": "同上，对全部活动/归档项目逐个重放",
};

/** 写路由的归类问题：既非用户专属也不在放行清单，或放行清单里有已不存在/已改成用户专属的条目。 */
function unclassifiedWrites(routes: readonly AtmRouteEntry[], allowed: Record<string, string>) {
  const writes = routes.filter((route) => !READ_METHODS.has(route.method));
  const keys = new Set(writes.map((route) => `${route.method} ${route.url}`));
  return [
    ...writes
      .filter((route) => route.principal !== "USER" && !(`${route.method} ${route.url}` in allowed))
      .map((route) => `unclassified ${route.method} ${route.url}`),
    ...writes
      .filter((route) => route.principal === "USER" && `${route.method} ${route.url}` in allowed)
      .map((route) => `both ${route.method} ${route.url}`),
    ...Object.keys(allowed)
      .filter((key) => !keys.has(key))
      .map((key) => `stale ${key}`),
  ];
}

function userOnlyRoutes(routes: readonly AtmRouteEntry[]): AtmRouteEntry[] {
  return routes.filter((route) => route.principal === "USER");
}

async function server(userToken?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-user-authz-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const app = await buildAyanamiServer({
    service,
    token: AGENT,
    ...(userToken === undefined ? {} : { userToken }),
  });
  return {
    service,
    app,
    async close() {
      await app.close();
      service.close();
    },
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const concrete = (path: string) =>
  path.replace(/:code/gu, "AUTHZ").replace(/:\w+/gu, "01M00000000000000000000000");

// ATM-T-0503：daemon.json 里的令牌谁都能读，用户的决定不能只凭它放行。
describe("用户凭证与 Agent 凭证分离", () => {
  it("每条写路由都已归类：用户专属，或带理由的 Agent 放行", async () => {
    const { app, close } = await server(USER);
    try {
      expect(app.atmRoutes.length).toBeGreaterThan(100);
      expect(unclassifiedWrites(app.atmRoutes, AGENT_WRITES)).toEqual([]);

      // 阳性对照：漏标、重复归类、过期放行都要认出来。
      const probe: AtmRouteEntry[] = [
        { method: "DELETE", url: "/api/v1/saved-views/:id", principal: "ANY" },
        { method: "POST", url: "/api/v1/sessions", principal: "USER" },
        { method: "GET", url: "/api/v1/projects", principal: "ANY" },
      ];
      expect(
        unclassifiedWrites(probe, {
          "POST /api/v1/sessions": "x",
          "POST /api/v1/gone": "x",
        }),
      ).toEqual([
        "unclassified DELETE /api/v1/saved-views/:id",
        "both POST /api/v1/sessions",
        "stale POST /api/v1/gone",
      ]);
    } finally {
      await close();
    }
  });

  it("每条用户操作路由都拒绝 Agent 令牌，且不碰数据", async () => {
    const { service, app, close } = await server(USER);
    try {
      // 断言放在 try 里：失败时也要先关库，否则临时目录删不掉。
      const routes = userOnlyRoutes(app.atmRoutes);
      expect(routes.length).toBeGreaterThanOrEqual(25);
      await service.createProject({ name: "授权边界", sourcePath: null, code: "AUTHZ" });
      for (const route of routes) {
        const response = await app.inject({
          method: route.method as "POST",
          url: concrete(route.url),
          headers: bearer(AGENT),
          payload: { actor: "USER", opId: "authz-probe" },
        });
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
        expect(response.json().error, route.url).toMatchObject({
          code: "USER_AUTHORIZATION_REQUIRED",
        });
      }
      expect(service.databases.getProject("AUTHZ").lifecycle).toBe("ACTIVE");
    } finally {
      await close();
    }
  });

  it("用户令牌能走用户操作路由，Agent 令牌照常走 Agent 路由", async () => {
    const { service, app, close } = await server(USER);
    try {
      await service.createProject({ name: "垃圾箱", sourcePath: null, code: "AUTHZ" });
      await service.trashProject("AUTHZ");
      const request = service.databases.requestProjectRestore("AUTHZ", {
        requestedBy: "authz-agent",
        sourceCwd: null,
      });
      const approve = (token: string) =>
        app.inject({
          method: "POST",
          url: `/api/v1/trash/restore-requests/${request.id}/approve`,
          headers: bearer(token),
        });
      expect((await approve(AGENT)).statusCode).toBe(403);
      expect(service.databases.getProject("AUTHZ").lifecycle).toBe("TRASHED");
      const approved = await approve(USER);
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({ project: { lifecycle: "ACTIVE" } });

      const listed = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: bearer(AGENT),
      });
      expect(listed.statusCode).toBe(200);
      const objective = await app.inject({
        method: "POST",
        url: "/api/v1/projects/AUTHZ/objectives",
        headers: bearer(AGENT),
        payload: { title: "Agent 建的目标" },
      });
      expect(objective.statusCode).not.toBe(403);
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/projects", headers: bearer("wrong") }))
          .statusCode,
      ).toBe(401);
    } finally {
      await close();
    }
  });

  // ATM-T-0506 peer：保存的视图是用户在项目页存下的偏好，Agent 令牌原来能删掉它（实测 200）。
  it("保存的视图只有用户能建、改、删；Agent 令牌被拒且视图原样保留", async () => {
    const { app, close } = await server(USER);
    try {
      const create = (token: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/saved-views",
          headers: bearer(token),
          payload: { scope: "GLOBAL", name: "我的阻塞视图", query: { status: "BLOCKED" } },
        });
      expect((await create(AGENT)).statusCode).toBe(403);
      const created = await create(USER);
      expect(created.statusCode).toBe(201);
      const view = created.json() as { id: string; version: number };
      const listViews = async () =>
        (
          await app.inject({ method: "GET", url: "/api/v1/saved-views", headers: bearer(AGENT) })
        ).json() as Array<{ id: string; name: string; version: number }>;

      const renamed = await app.inject({
        method: "PATCH",
        url: `/api/v1/saved-views/${view.id}`,
        headers: bearer(AGENT),
        payload: { expectedVersion: view.version, name: "被 Agent 改名" },
      });
      expect(renamed.statusCode).toBe(403);
      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/v1/saved-views/${view.id}?expectedVersion=${view.version}`,
        headers: bearer(AGENT),
      });
      expect(deleted.statusCode).toBe(403);
      expect(deleted.json().error).toMatchObject({ code: "USER_AUTHORIZATION_REQUIRED" });
      expect(await listViews()).toEqual([
        expect.objectContaining({ id: view.id, name: "我的阻塞视图", version: view.version }),
      ]);

      const removed = await app.inject({
        method: "DELETE",
        url: `/api/v1/saved-views/${view.id}?expectedVersion=${view.version}`,
        headers: bearer(USER),
      });
      expect(removed.statusCode).toBe(200);
      expect(await listViews()).toEqual([]);
    } finally {
      await close();
    }
  });

  // ATM-T-0508 peer：手动备份每组只留 otherKeep（默认 2）份，新建会淘汰最旧的。
  // Agent 令牌原来能借「新建备份」挤掉用户留着的手动备份，文件一并删掉。
  it("Agent 令牌不能新建备份，也就挤不掉用户的手动备份", async () => {
    const { service, app, close } = await server(USER);
    try {
      await service.createProject({ name: "备份边界", sourcePath: null, code: "AUTHZ" });
      const backup = (token: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/backups",
          headers: bearer(token),
          payload: { scope: "PROJECT", project: "AUTHZ" },
        });
      const first = (await backup(USER)).json() as { id: string; path: string };
      const second = (await backup(USER)).json() as { id: string; path: string };
      const manual = () =>
        service
          .listBackups("AUTHZ")
          .filter((row) => row.reason === "MANUAL")
          .map((row) => row.id)
          .sort();

      const refused = await backup(AGENT);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toMatchObject({ code: "USER_AUTHORIZATION_REQUIRED" });
      expect(manual()).toEqual([first.id, second.id].sort());
      expect(existsSync(first.path)).toBe(true);
      expect(existsSync(second.path)).toBe(true);

      // 用户自己再建一份，淘汰最旧的：这是用户的决定，照常生效。
      const third = (await backup(USER)).json() as { id: string };
      expect(manual()).toEqual([second.id, third.id].sort());
      expect(existsSync(first.path)).toBe(false);
    } finally {
      await close();
    }
  });

  // ATM-T-0508 复核：REST 的知识保存是管理界面入口——不记 Agent 作者、不要 Session、
  // 还能改已归档的知识；Agent 该走 MCP atm_knowledge_save。
  it("知识的新建与更新只认用户令牌；Agent 路由也不能借 session=USER 冒充用户", async () => {
    const { service, app, close } = await server(USER);
    try {
      await service.createProject({ name: "知识边界", sourcePath: null, code: "AUTHZ" });
      const knowledge = {
        opId: "authz-knowledge",
        expectedVersion: 0,
        slug: "authz-knowledge",
        title: "授权边界",
        summary: "测试用",
        useWhen: "测试",
        tags: [],
        aliases: [],
        appliesTo: [],
        bodyMarkdown: "正文",
        sourceRefs: [],
      };
      const save = (token: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/knowledge",
          headers: bearer(token),
          payload: knowledge,
        });
      expect((await save(AGENT)).statusCode).toBe(403);
      expect((await save(USER)).statusCode).toBeLessThan(300);

      // 同一个请求只换 session：真实的 Agent session 能写（阳性对照），session=USER 被拒。
      const begun = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: bearer(AGENT),
        payload: { mode: "project", projectCode: "AUTHZ", agentId: "authz-agent", signals: {} },
      });
      expect(begun.statusCode).toBe(201);
      const record = (session: string, opId: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/projects/AUTHZ/records",
          headers: bearer(AGENT),
          payload: {
            session,
            opId,
            kind: "FACT",
            title: "边界",
            summary: "记录",
            scope: "PROJECT",
          },
        });
      expect((await record(String(begun.json().session), "authz-rec-real")).statusCode).toBe(201);
      expect((await record("USER", "authz-rec-user")).statusCode).toBeGreaterThanOrEqual(400);
      const repository = await service.databases.openProject("AUTHZ");
      const records = repository.sqlite.prepare("SELECT actor FROM records").all() as Array<{
        actor: string;
      }>;
      expect(records).toHaveLength(1);
      expect(records[0]!.actor).not.toBe("USER");
    } finally {
      await close();
    }
  });

  it("临时任务以 USER 身份落账需要用户令牌；Agent 写自己的 actor 照常", async () => {
    const { app, close } = await server(USER);
    try {
      const create = (token: string, actor?: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/quick-tasks",
          headers: bearer(token),
          payload: { title: "临时检查", ...(actor === undefined ? {} : { actor }) },
        });
      expect((await create(AGENT)).statusCode).toBe(403);
      expect((await create(AGENT, "USER")).statusCode).toBe(403);
      const own = await create(AGENT, "codex-agent");
      expect(own.statusCode).toBe(201);
      expect((await create(USER)).statusCode).toBe(201);

      const created = own.json() as { id: string; version: number };
      const patch = await app.inject({
        method: "PATCH",
        url: `/api/v1/quick-tasks/${created.id}`,
        headers: bearer(AGENT),
        payload: { status: "DONE", expectedVersion: created.version },
      });
      expect(patch.statusCode).toBe(403);
    } finally {
      await close();
    }
  });

  it("未配置用户令牌时保持单令牌模式：那一个令牌同时代表用户", async () => {
    expect(authenticate(AGENT, { token: AGENT })).toBe("USER");
    expect(authenticate(AGENT, { token: AGENT, userToken: USER })).toBe("AGENT");
    expect(authenticate(USER, { token: AGENT, userToken: USER })).toBe("USER");
    expect(authenticate("wrong", { token: AGENT, userToken: USER })).toBeNull();
    expect(authenticate(undefined, { token: AGENT })).toBeNull();
    expect(authenticate(42, { token: AGENT })).toBeNull();
  });

  it("带用户身份的路由都挂了 USER_ONLY；守卫认得出漏标", () => {
    const blocks = routeBlocks(sourceFiles());
    expect(blocks.length).toBeGreaterThan(40);
    expect(unguardedUserRoutes(blocks)).toEqual([]);

    // 阳性对照：同一种根因的几种写法都要被认出来。
    const bad = routeBlocks([
      {
        file: "bad.ts",
        text: [
          'app.post("/a", async () => service.createObjectiveAsUser(code));',
          'app.post("/b", async () => parse({ ...body, session: "USER" }));',
          'app.post("/c", async () => options.service.restoreProject(code));',
          'app.post("/d", USER_ONLY, async () => options.service.restoreProject(code));',
          'app.post("/e", async (request) => { assertUser(request, "x"); return options.service.restoreProject(code); });',
        ].join("\n"),
      },
    ]);
    expect(unguardedUserRoutes(bad)).toEqual([
      "bad.ts POST /a",
      "bad.ts POST /b",
      "bad.ts POST /c",
    ]);
  });
});
