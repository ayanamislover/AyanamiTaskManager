import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { authenticate, buildAyanamiServer } from "../src/index.js";

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

function userOnlyRoutes(): RouteBlock[] {
  return routeBlocks(sourceFiles()).filter((block) =>
    /^app\.\w+\(\s*"[^"]+",\s*USER_ONLY,/u.test(block.text),
  );
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
  it("每条用户操作路由都拒绝 Agent 令牌，且不碰数据", async () => {
    const routes = userOnlyRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(21);
    const { service, app, close } = await server(USER);
    try {
      await service.createProject({ name: "授权边界", sourcePath: null, code: "AUTHZ" });
      for (const route of routes) {
        const response = await app.inject({
          method: route.method as "POST",
          url: concrete(route.path),
          headers: bearer(AGENT),
          payload: { actor: "USER", opId: "authz-probe" },
        });
        expect(response.statusCode, `${route.method} ${route.path}`).toBe(403);
        expect(response.json().error, route.path).toMatchObject({
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
