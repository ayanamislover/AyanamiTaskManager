import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

describe("atm_begin brief ownership", () => {
  it("reads one snapshot in MCP and never builds the legacy application brief", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-single-begin-brief-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Single begin brief",
      sourcePath: null,
      code: "ONEBRF",
    });
    const snapshot = vi.spyOn(service, "briefSnapshot");
    const profiles = await connectProfiledClients(service, "single-begin-brief");
    try {
      const response = await profiles.coreClient.callTool({
        name: "atm_begin",
        arguments: {
          project_code: project.code,
          mode: "project",
          agent_id: "single-brief-agent",
          op_id: "single-brief-begin",
          brief: "full",
          max_chars: 5000,
        },
      });

      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(response.structuredContent).toMatchObject({
        scope: "project",
        project: project.code,
        session: expect.stringMatching(/^01/u),
        surface_version: 3,
        brief_mode: "full",
        brief_truncated: false,
        atomicBegin: { operationId: "single-brief-begin", disposition: "CREATED" },
      });
    } finally {
      await profiles.close();
      service.close();
    }
  });

  it("replays the same operation when only the brief budget changes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-begin-budget-replay-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Begin budget replay",
      sourcePath: null,
      code: "BEGRPL",
    });
    const snapshot = vi.spyOn(service, "briefSnapshot");
    const profiles = await connectProfiledClients(service, "begin-budget-replay");
    const common = {
      project_code: project.code,
      mode: "project",
      agent_id: "budget-replay-agent",
      op_id: "begin-budget-replay-operation",
      brief: "full",
    };
    try {
      const first = await profiles.coreClient.callTool({
        name: "atm_begin",
        arguments: { ...common, max_chars: 1200 },
      });
      const replay = await profiles.coreClient.callTool({
        name: "atm_begin",
        arguments: { ...common, max_chars: 5000 },
      });

      expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
      expect(replay.isError, JSON.stringify(replay.content)).not.toBe(true);
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(first.structuredContent).toMatchObject({
        scope: "project",
        project: project.code,
        session: expect.stringMatching(/^01/u),
        surface_version: 3,
        brief_mode: "full",
        atomicBegin: { operationId: common.op_id, disposition: "CREATED" },
      });
      expect(replay.structuredContent).toMatchObject({
        scope: "project",
        project: project.code,
        session: first.structuredContent?.session,
        surface_version: 3,
        brief_mode: "full",
        atomicBegin: { operationId: common.op_id, disposition: "RECOVERED" },
      });
    } finally {
      await profiles.close();
      service.close();
    }
  });
});
