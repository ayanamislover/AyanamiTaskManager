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

async function connect() {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-validation-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  services.push(service);
  await service.createProject({ name: "校验", sourcePath: null, code: "VALD" });
  const profiles = await connectProfiledClients(service, "validation-test");
  connections.push(profiles.close);
  return profiles;
}

const textOf = (response: { content: unknown }) =>
  String((response.content as Array<{ text?: unknown }>)[0]?.text ?? "");

describe("一次调用里的校验错误一次报全", () => {
  // 客户端按发布的 JSON Schema 先校验一轮，但常把 maxLength 渲染丢掉；长度类问题只能由
  // 服务端报。服务端这一轮必须把所有字段的问题一起报出来，并说清超了多少——否则调用方
  // 要为每个字段各重传一次 3–6KB 的 detail，还会因为数错一个字再被拒一次。
  it("atm_record 的多个超限字段在同一条错误里全部列出，并给出要删掉的量", async () => {
    const profiles = await connect();
    const response = await profiles.client.callTool({
      name: "atm_record",
      arguments: {
        project: "VALD",
        kind: "FACT",
        title: "标".repeat(401),
        summary: "摘".repeat(315),
        scope: "S".repeat(101),
        op_id: "validation-at-once",
      },
    });
    expect(response.isError).toBe(true);
    const text = textOf(response);
    expect(text).toMatch(/^INVALID_ARGUMENT/u);
    // 缺 session 与三个超限字段在同一条错误里，不需要改一处重发一次。
    for (const path of ["session", "title", "summary", "scope"])
      expect(text).toContain(`→ at ${path}`);
    // 315 个字符超 300 个：直接告诉调用方还要删 15 个，而不是只给上限让它自己再数一遍。
    expect(text).toContain('"over_by":15');
    expect(text).toContain('"over_by":1,"path":"title"');
    // 同一个问题只报一遍：以前 protocol 与 MCP 各挂一个检查，summary 会出现两条。
    expect(text.match(/→ at summary/gu)).toHaveLength(1);
  });

  it("atm_progress_add 与 atm_end 的长度超限同样给出要删掉的量", async () => {
    const profiles = await connect();
    const progress = await profiles.client.callTool({
      name: "atm_progress_add",
      arguments: {
        project: "VALD",
        session: "S",
        op_id: "validation-progress",
        scope: "project",
        summary: "进".repeat(503),
        blocker: "阻".repeat(1004),
      },
    });
    expect(progress.isError).toBe(true);
    expect(textOf(progress)).toContain('"over_by":3,"path":"summary"');
    expect(textOf(progress)).toContain('"over_by":4,"path":"blocker"');

    const end = await profiles.client.callTool({
      name: "atm_end",
      arguments: {
        project: "VALD",
        session: "S",
        op_id: "validation-end",
        outcome: "completed",
        summary: "结".repeat(510),
      },
    });
    expect(end.isError).toBe(true);
    expect(textOf(end)).toContain('"over_by":10,"path":"summary"');
  });

  it("atm_feedback 的摘要超限同样给出要删掉的量", async () => {
    const profiles = await connect();
    const response = await profiles.client.callTool({
      name: "atm_feedback",
      arguments: {
        project: "VALD",
        summary: "反".repeat(302),
        op_id: "validation-feedback",
      },
    });
    expect(response.isError).toBe(true);
    expect(textOf(response)).toContain('"over_by":2');
  });
});
