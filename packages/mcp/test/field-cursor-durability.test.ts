import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

async function fixture(code: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-field-cursor-durable-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  const project = await service.createProject({
    name: "Durable field cursor",
    sourcePath: null,
    code,
  });
  const begun = await service.begin({
    projectCode: project.code,
    mode: "project",
    agentId: "durable-cursor-agent",
    clientKind: "test",
  });
  const objective = await service.createObjective(project.code, begun.session, {
    title: "Durable field cursor",
    description: "",
    definitionOfDone: [],
  });
  const description = Array.from({ length: 4200 }, (_, index) =>
    String.fromCharCode(65 + (index % 26)),
  ).join("");
  const created = await service.createWorkItems(
    project.code,
    begun.session,
    "durable-cursor-task",
    [
      {
        clientRef: "task",
        objectiveId: objective.id,
        title: "Durable cursor source",
        description,
        type: "TASK",
        priority: "HIGH",
        status: "READY",
      },
      {
        clientRef: "other",
        objectiveId: objective.id,
        title: "Other cursor target",
        description,
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
      },
    ],
  );
  const profiles = await connectProfiledClients(service, `durable-${code}`);
  return {
    service,
    project,
    begun,
    description,
    taskKey: created.items[0]!.key,
    otherTaskKey: created.items[1]!.key,
    profiles,
  };
}

async function firstCursor(
  client: Client,
  project: string,
  taskKey: string,
  maxChars = 700,
): Promise<{ cursor: string; value: string }> {
  const result = await client.callTool({
    name: "atm_task_get",
    arguments: {
      project,
      task_key: taskKey,
      view: "full",
      field_mask: ["key", "description"],
      max_chars: maxChars,
    },
  });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const body = result.structuredContent as {
    description: string;
    truncated_fields: Array<{ continuation: { cursor: string } }>;
  };
  return {
    cursor: body.truncated_fields[0]!.continuation.cursor,
    value: body.description,
  };
}

async function connectFreshCore(service: AyanamiTaskService, name: string) {
  vi.resetModules();
  const { createAyanamiMcpServer } = await import("../src/index.js");
  const server = createAyanamiMcpServer(service, { profile: "core" });
  const client = new Client({ name, version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

describe("durable field cursor v2", () => {
  it("is deterministic across a fresh MCP module and permits max_chars retry/change", async () => {
    const ctx = await fixture("FCDUR");
    let fresh: Awaited<ReturnType<typeof connectFreshCore>> | undefined;
    try {
      const first = await firstCursor(ctx.profiles.coreClient, ctx.project.code, ctx.taskKey);
      const constrained = await ctx.profiles.coreClient.callTool({
        name: "atm_task_get",
        arguments: {
          project: ctx.project.code,
          task_key: ctx.taskKey,
          view: "full",
          field_mask: ["key", "description"],
          max_chars: 300,
          cursor: first.cursor,
        },
      });
      expect(constrained.isError).toBe(true);
      expect(constrained.structuredContent).toMatchObject({
        code: "RESULT_TOO_LARGE",
        details: {
          recovery: { action: "increase_max_chars", preserve_cursor: true },
        },
      });

      const retried = await ctx.profiles.coreClient.callTool({
        name: "atm_task_get",
        arguments: {
          project: ctx.project.code,
          task_key: ctx.taskKey,
          view: "full",
          field_mask: ["key", "description"],
          max_chars: 1200,
          cursor: first.cursor,
        },
      });
      expect(retried.isError, JSON.stringify(retried.content)).not.toBe(true);
      expect(retried.structuredContent).toMatchObject({
        offset: first.value.length,
        value: expect.any(String),
      });

      await ctx.profiles.close();
      fresh = await connectFreshCore(ctx.service, "durable-cursor-fresh-core");
      const repeated = await firstCursor(fresh.client, ctx.project.code, ctx.taskKey);
      expect(repeated.cursor).toBe(first.cursor);
      const continued = await fresh.client.callTool({
        name: "atm_task_get",
        arguments: {
          project: ctx.project.code,
          task_key: ctx.taskKey,
          view: "full",
          field_mask: ["key", "description"],
          max_chars: 1200,
          cursor: first.cursor,
        },
      });
      expect(continued.isError, JSON.stringify(continued.content)).not.toBe(true);
    } finally {
      if (fresh) await fresh.close();
      else await ctx.profiles.close();
      ctx.service.close();
    }
  });

  it("returns typed stale and target-mismatch recovery without parsing messages", async () => {
    const ctx = await fixture("FCSTALE");
    try {
      const first = await firstCursor(ctx.profiles.coreClient, ctx.project.code, ctx.taskKey);
      const task = await ctx.service.getWorkItem(ctx.project.code, ctx.taskKey, "full");
      await ctx.service.patchWorkItems(
        ctx.project.code,
        ctx.begun.session,
        "advance-cursor-version",
        [
          {
            taskKey: ctx.taskKey,
            expectedVersion: task.version,
            operation: "edit",
            title: "Cursor source changed outside the continued field",
          },
        ],
      );

      const stale = await ctx.profiles.coreClient.callTool({
        name: "atm_task_get",
        arguments: {
          project: ctx.project.code,
          task_key: ctx.taskKey,
          view: "full",
          field_mask: ["key", "description"],
          max_chars: 900,
          cursor: first.cursor,
        },
      });
      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toMatchObject({
        code: "CONTINUATION_CONFLICT",
        details: {
          reason: "STALE",
          recovery: { action: "restart_read", omit_cursor: true },
        },
      });

      const mismatch = await ctx.profiles.coreClient.callTool({
        name: "atm_task_get",
        arguments: {
          project: ctx.project.code,
          task_key: ctx.otherTaskKey,
          view: "full",
          field_mask: ["key", "description"],
          max_chars: 900,
          cursor: first.cursor,
        },
      });
      expect(mismatch.isError).toBe(true);
      expect(mismatch.structuredContent).toMatchObject({
        code: "CONTINUATION_CONFLICT",
        details: {
          reason: "TARGET_MISMATCH",
          recovery: { action: "retry_original_target", preserve_cursor: true },
        },
      });
    } finally {
      await ctx.profiles.close();
      ctx.service.close();
    }
  });

  it("distinguishes tampered and expired tokens with typed restart recovery", async () => {
    const ctx = await fixture("FCINVALID");
    try {
      const first = await firstCursor(ctx.profiles.coreClient, ctx.project.code, ctx.taskKey);
      const finalCharacter = first.cursor.at(-1)!;
      const tamperedToken = `${first.cursor.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;
      const tampered = await ctx.profiles.coreClient.callTool({
        name: "atm_task_get",
        arguments: {
          project: ctx.project.code,
          task_key: ctx.taskKey,
          view: "full",
          field_mask: ["key", "description"],
          max_chars: 900,
          cursor: tamperedToken,
        },
      });
      expect(tampered.isError).toBe(true);
      expect(tampered.structuredContent).toMatchObject({
        code: "INVALID_CURSOR",
        details: {
          reason: "INVALID_OR_TAMPERED",
          recovery: { action: "restart_read", omit_cursor: true },
        },
      });

      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 31 * 24 * 60 * 60 * 1000);
      const expired = await ctx.profiles.coreClient.callTool({
        name: "atm_task_get",
        arguments: {
          project: ctx.project.code,
          task_key: ctx.taskKey,
          view: "full",
          field_mask: ["key", "description"],
          max_chars: 900,
          cursor: first.cursor,
        },
      });
      expect(expired.isError).toBe(true);
      expect(expired.structuredContent).toMatchObject({
        code: "INVALID_CURSOR",
        details: {
          reason: "EXPIRED",
          recovery: { action: "restart_read", omit_cursor: true },
        },
      });
    } finally {
      await ctx.profiles.close();
      ctx.service.close();
    }
  });

  it("retains at least one full TTL across an expiry-bucket boundary", async () => {
    const ctx = await fixture("FCBOUNDARY");
    try {
      const ttl = 7 * 24 * 60 * 60 * 1000;
      const boundary = (Math.floor(Date.now() / ttl) + 1) * ttl;
      const now = vi.spyOn(Date, "now").mockReturnValue(boundary - 1);
      const first = await firstCursor(ctx.profiles.coreClient, ctx.project.code, ctx.taskKey);
      now.mockReturnValue(boundary + 1);

      const continued = await ctx.profiles.coreClient.callTool({
        name: "atm_task_get",
        arguments: {
          project: ctx.project.code,
          task_key: ctx.taskKey,
          view: "full",
          field_mask: ["key", "description"],
          max_chars: 900,
          cursor: first.cursor,
        },
      });
      expect(continued.isError, JSON.stringify(continued.content)).not.toBe(true);
    } finally {
      await ctx.profiles.close();
      ctx.service.close();
    }
  });
});
