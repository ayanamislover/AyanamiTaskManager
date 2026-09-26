import { readdirSync, readFileSync, statSync } from "node:fs";
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

/** MCP 源码里任何能把垃圾箱项目拉回来的调用；Agent 只能请求，不能自己恢复或授权。 */
const RESTORE_CALLS = /\b(restoreProject|decideProjectRestoreRequest|setProjectLifecycle)\s*\(/u;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function restoreCallSites(files: Array<{ path: string; text: string }>): string[] {
  return files.filter((file) => RESTORE_CALLS.test(file.text)).map((file) => file.path);
}

// ATM-T-0493 / 0494：垃圾箱项目只能由用户在 ATM 界面授权恢复。
describe("atm_begin 撞上垃圾箱项目", () => {
  it("报错里带着恢复请求编号和授权指引，项目仍在垃圾箱", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-trashed-"));
    const sourcePath = await mkdtemp(join(tmpdir(), "atm-mcp-trashed-source-"));
    roots.push(dataDir, sourcePath);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    services.push(service);
    const project = await service.createProject({ name: "垃圾箱", sourcePath, code: "MTRSH" });
    await service.trashProject(project.code);
    const profiles = await connectProfiledClients(service, "trashed-begin");
    connections.push(profiles.close);

    const response = await profiles.client.callTool({
      name: "atm_begin",
      arguments: {
        cwd: sourcePath,
        mode: "auto",
        agent_id: "mcp-trashed-agent",
        allow_project_create: true,
      },
    });
    expect(response.isError).toBe(true);
    const text = (response.content as Array<{ text?: string }>)[0]?.text ?? "";
    const pending = service.listTrashedProjects()[0]?.restoreRequest;
    expect(pending).toMatchObject({ status: "PENDING", requestedBy: "mcp-trashed-agent" });
    expect(text).toContain("PROJECT_DB_UNAVAILABLE");
    expect(text).toContain(pending!.id);
    expect(text).toContain("await_user_restore_authorization");
    expect(text).toContain("ATM「项目 → 垃圾箱」");
    expect(service.databases.getProject(project.id).lifecycle).toBe("TRASHED");
  });

  it("MCP 工具面没有任何恢复或授权入口", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-trashed-surface-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    services.push(service);
    const profiles = await connectProfiledClients(service, "trashed-surface");
    connections.push(profiles.close);
    const tools = (
      await Promise.all(
        [profiles.coreClient, profiles.memoryClient, profiles.actionsClient].map(
          async (client) => (await client.listTools()).tools,
        ),
      )
    ).flat();
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/restore|trash|approve/iu);
      // 不查 approve：review_submit 的 verdict 本来就有 APPROVED。
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/restore|trash/iu);
    }

    const files = sourceFiles(join(process.cwd(), "packages", "mcp", "src")).map((path) => ({
      path,
      text: readFileSync(path, "utf8"),
    }));
    expect(files.length).toBeGreaterThan(10);
    expect(restoreCallSites(files)).toEqual([]);
    // 阳性对照：守卫确实认得出这类调用。
    expect(
      restoreCallSites([
        { path: "bad.ts", text: "await service.decideProjectRestoreRequest(id, 'APPROVED');" },
        { path: "bad2.ts", text: "service.restoreProject(code)" },
      ]),
    ).toEqual(["bad.ts", "bad2.ts"]);
  });
});
