import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

async function fixture(code: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-exact-entity-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  const project = await service.createProject({ name: "Exact MCP entity", sourcePath: null, code });
  const begun = await service.begin({
    projectCode: project.code,
    mode: "project",
    agentId: "exact-mcp-agent",
    displayName: "Exact MCP Agent",
    clientKind: "test",
  });
  const objective = await service.createObjective(project.code, begun.session, {
    title: "Exact MCP entities",
    description: "",
    definitionOfDone: [],
  });
  const created = await service.createWorkItems(project.code, begun.session, "exact-mcp-task", [
    {
      clientRef: "task",
      objectiveId: objective.id,
      title: "Expose exact entities",
      description: "",
      type: "TASK",
      priority: "HIGH",
      status: "READY",
    },
  ]);
  const taskKey = created.items[0]!.key;
  const progress = await service.addProgress(project.code, begun.session, "exact-mcp-progress", {
    taskKey,
    percent: 47,
    summary: "Exact Progress DTO",
    completed: [{ text: "storage exact read", workItemKey: taskKey }],
    next: ["MCP exact projection"],
    evidence: [{ kind: "atm_task", value: taskKey }],
  });
  const profiles = await connectProfiledClients(service, `exact-${code}`);
  return { service, project, begun, taskKey, progress, profiles };
}

describe("MCP exact Progress/Session reads and field cursor v2", () => {
  it("resolves progress:<ULID> and session:<ULID> before full-text search", async () => {
    const { service, project, begun, taskKey, progress, profiles } = await fixture("XENT");
    try {
      const progressResult = await profiles.memoryClient.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query: `progress:${progress.progressId}`,
          max_chars: 10_000,
        },
      });
      expect(progressResult.isError, JSON.stringify(progressResult.content)).not.toBe(true);
      expect(progressResult.structuredContent).toEqual({
        exact: true,
        entity_type: "PROGRESS",
        entity: {
          id: progress.progressId,
          task_key: taskKey,
          percent: 47,
          progress_bucket: 50,
          summary: "Exact Progress DTO",
          completed: [{ text: "storage exact read", work_item_key: taskKey }],
          next: ["MCP exact projection"],
          blocker: null,
          actor: "exact-mcp-agent",
          session_id: begun.session,
          evidence: [{ kind: "atm_task", value: taskKey }],
          op_id: "exact-mcp-progress",
          created_at: expect.any(String),
        },
      });

      const sessionResult = await profiles.memoryClient.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query: `session:${begun.session}`,
          max_chars: 10_000,
        },
      });
      expect(sessionResult.isError, JSON.stringify(sessionResult.content)).not.toBe(true);
      expect(sessionResult.structuredContent).toMatchObject({
        exact: true,
        entity_type: "SESSION",
        entity: {
          id: begun.session,
          agent_id: "exact-mcp-agent",
          display_name: "Exact MCP Agent",
          client_kind: "test",
          role: "PRIMARY",
          connection_state: "ONLINE",
          current_task_key: null,
          git: {
            available: false,
            repo_root: null,
            worktree_root: null,
            common_dir: null,
          },
        },
      });
      const sessionEntity = (sessionResult.structuredContent as Record<string, any>).entity;
      expect(sessionEntity).not.toHaveProperty("current_work_item_id");
      expect(sessionEntity).not.toHaveProperty("capabilities_json");
    } finally {
      await profiles.close();
      service.close();
    }
  });

  it("fails closed for malformed, unknown, missing-project and wrong-project exact ids", async () => {
    const { service, project, begun, progress, profiles } = await fixture("XFAIL");
    try {
      const otherProject = await service.createProject({
        name: "Wrong exact-read project",
        sourcePath: null,
        code: "XFAILO",
      });
      const cases = [
        {
          arguments: { project: project.code, query: "progress:not-a-ulid" },
          error: /VALIDATION_ERROR/u,
        },
        {
          arguments: { query: `progress:${progress.progressId}` },
          error: /PROJECT_REQUIRED/u,
        },
        {
          arguments: { project: project.code, query: "progress:00000000000000000000000000" },
          error: /PROGRESS_NOT_FOUND/u,
        },
        {
          arguments: { project: otherProject.code, query: `progress:${progress.progressId}` },
          error: /PROGRESS_NOT_FOUND/u,
        },
        {
          arguments: { project: otherProject.code, query: `session:${begun.session}` },
          error: /SESSION_NOT_FOUND/u,
        },
      ];
      for (const testCase of cases) {
        const result = await profiles.memoryClient.callTool({
          name: "atm_search",
          arguments: testCase.arguments,
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(testCase.error);
      }
    } finally {
      await profiles.close();
      service.close();
    }
  });

  it("binds signed field cursors to project, entity, type, mask, path, content and offset", async () => {
    const { service, project, begun, taskKey, profiles } = await fixture("XCUR");
    try {
      const longValue = Array.from({ length: 2600 }, (_, index) =>
        String.fromCharCode(65 + (index % 26)),
      ).join("");
      const firstProgress = await service.addProgress(
        project.code,
        begun.session,
        "cursor-first-progress",
        {
          taskKey,
          percent: 60,
          summary: "first cursor entity",
          next: [longValue],
        },
      );
      const secondProgress = await service.addProgress(
        project.code,
        begun.session,
        "cursor-second-progress",
        {
          taskKey,
          percent: 70,
          summary: "second cursor entity",
          next: [longValue.toLowerCase()],
        },
      );
      const query = `progress:${firstProgress.progressId}`;
      const first = await profiles.memoryClient.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query,
          field_mask: ["id", "next"],
          max_chars: 900,
        },
      });
      expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
      const firstBody = first.structuredContent as {
        entity: {
          id: string;
          next: string[];
          truncated_fields: Array<{ path: string; continuation: { cursor: string } }>;
        };
      };
      expect(firstBody.entity.id).toBe(firstProgress.progressId);
      expect(firstBody.entity.truncated_fields[0]).toMatchObject({
        path: "next[0]",
        continuation: { cursor: expect.any(String) },
      });

      let restored = firstBody.entity.next[0]!;
      let cursor: string | null = firstBody.entity.truncated_fields[0]!.continuation.cursor;
      while (cursor) {
        const page = await profiles.memoryClient.callTool({
          name: "atm_search",
          arguments: {
            project: project.code,
            query,
            field_mask: ["id", "next"],
            max_chars: 900,
            cursor,
          },
        });
        expect(page.isError, JSON.stringify(page.content)).not.toBe(true);
        const pageBody = page.structuredContent as {
          entity: { value: string; next_cursor: string | null };
        };
        restored += pageBody.entity.value;
        cursor = pageBody.entity.next_cursor;
      }
      expect(restored).toBe(longValue);

      const securityCursor = firstBody.entity.truncated_fields[0]!.continuation.cursor;
      const finalCharacter = securityCursor.at(-1)!;
      const tamperedCursor = `${securityCursor.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;
      const tampered = await profiles.memoryClient.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query,
          field_mask: ["id", "next"],
          max_chars: 900,
          cursor: tamperedCursor,
        },
      });
      expect(tampered.isError).toBe(true);
      expect(JSON.stringify(tampered.content)).toMatch(/INVALID_CURSOR/u);

      const crossEntity = await profiles.memoryClient.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query: `progress:${secondProgress.progressId}`,
          field_mask: ["id", "next"],
          max_chars: 900,
          cursor: securityCursor,
        },
      });
      expect(crossEntity.isError).toBe(true);
      expect(crossEntity.structuredContent).toMatchObject({
        code: "CONTINUATION_CONFLICT",
        details: { reason: "TARGET_MISMATCH" },
      });

      const typeProgress = await service.addProgress(
        project.code,
        begun.session,
        "cursor-type-progress",
        {
          taskKey,
          percent: 75,
          summary: "cursor type binding",
          next: [longValue],
        },
      );
      const currentDatabase = await service.databases.openProject(project.code);
      currentDatabase.sqlite
        .prepare("UPDATE progress_updates SET id = ? WHERE id = ?")
        .run(begun.session, typeProgress.progressId);
      const typeSource = await profiles.memoryClient.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query: `progress:${begun.session}`,
          field_mask: ["id", "next"],
          max_chars: 900,
        },
      });
      expect(typeSource.isError, JSON.stringify(typeSource.content)).not.toBe(true);
      const typeCursor = (typeSource.structuredContent as Record<string, any>).entity
        .truncated_fields[0].continuation.cursor;
      const crossType = await profiles.memoryClient.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query: `session:${begun.session}`,
          field_mask: ["id", "next"],
          max_chars: 900,
          cursor: typeCursor,
        },
      });
      expect(crossType.isError).toBe(true);
      expect(crossType.structuredContent).toMatchObject({
        code: "CONTINUATION_CONFLICT",
        details: { reason: "TARGET_MISMATCH" },
      });

      const crossMask = await profiles.memoryClient.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query,
          field_mask: ["summary"],
          max_chars: 900,
          cursor: securityCursor,
        },
      });
      expect(crossMask.isError).toBe(true);
      expect(crossMask.structuredContent).toMatchObject({
        code: "CONTINUATION_CONFLICT",
        details: { reason: "TARGET_MISMATCH" },
      });

      const otherProject = await service.createProject({
        name: "Other cursor project",
        sourcePath: null,
        code: "XCURO",
      });
      const otherBegun = await service.begin({
        projectCode: otherProject.code,
        mode: "project",
        agentId: "other-cursor-agent",
        clientKind: "test",
      });
      const otherObjective = await service.createObjective(otherProject.code, otherBegun.session, {
        title: "Other cursor entity",
        description: "",
        definitionOfDone: [],
      });
      const otherTask = await service.createWorkItems(
        otherProject.code,
        otherBegun.session,
        "other-cursor-task",
        [
          {
            clientRef: "task",
            objectiveId: otherObjective.id,
            title: "Other cursor task",
            type: "TASK",
            priority: "NORMAL",
            status: "READY",
          },
        ],
      );
      const otherProgress = await service.addProgress(
        otherProject.code,
        otherBegun.session,
        "other-cursor-progress",
        {
          taskKey: otherTask.items[0]!.key,
          percent: 60,
          summary: "other project cursor entity",
          next: [longValue],
        },
      );
      const otherDatabase = await service.databases.openProject(otherProject.code);
      otherDatabase.sqlite
        .prepare("UPDATE progress_updates SET id = ? WHERE id = ?")
        .run(firstProgress.progressId, otherProgress.progressId);
      const crossProject = await profiles.memoryClient.callTool({
        name: "atm_search",
        arguments: {
          project: otherProject.code,
          query,
          field_mask: ["id", "next"],
          max_chars: 900,
          cursor: securityCursor,
        },
      });
      expect(crossProject.isError).toBe(true);
      expect(crossProject.structuredContent).toMatchObject({
        code: "CONTINUATION_CONFLICT",
        details: { reason: "TARGET_MISMATCH" },
      });

      currentDatabase.sqlite
        .prepare("UPDATE progress_updates SET next_json = ? WHERE id = ?")
        .run(JSON.stringify([longValue.split("").reverse().join("")]), firstProgress.progressId);
      const changed = await profiles.memoryClient.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query,
          field_mask: ["id", "next"],
          max_chars: 900,
          cursor: securityCursor,
        },
      });
      expect(changed.isError).toBe(true);
      expect(changed.structuredContent).toMatchObject({
        code: "CONTINUATION_CONFLICT",
        details: { reason: "CONTENT_CHANGED" },
      });
    } finally {
      await profiles.close();
      service.close();
    }
  });

  it("passes op_id + Session through the exact trace for every persisted channel", async () => {
    const { service, project, begun, taskKey, profiles } = await fixture("XOPS");
    try {
      const second = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "second-op-agent",
        displayName: "Second Op Agent",
        clientKind: "test",
      });
      const unrelated = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "unrelated-op-agent",
        clientKind: "test",
      });

      await service.createRecord(project.code, begun.session, "shared-record-op", {
        kind: "FACT",
        title: "first Session record",
        summary: "first Session owns this record",
      });
      await service.createRecord(project.code, second.session, "shared-record-op", {
        kind: "FACT",
        title: "second Session record",
        summary: "second Session owns this record",
      });
      await service.addProgress(project.code, begun.session, "shared-progress-op", {
        taskKey,
        percent: 71,
        summary: "first Session progress",
      });
      await service.addProgress(project.code, second.session, "shared-progress-op", {
        taskKey,
        percent: 72,
        summary: "second Session progress",
      });
      await service.addProjectProgress(project.code, begun.session, "shared-project-op", {
        health: "ON_TRACK",
        summary: "first Session project update",
      });
      await service.addProjectProgress(project.code, second.session, "shared-project-op", {
        health: "AT_RISK",
        summary: "second Session project update",
      });

      const readTrace = async (op: string) => {
        const response = await profiles.memoryClient.callTool({
          name: "atm_search",
          arguments: {
            project: project.code,
            op_id: op,
            session: begun.session,
            max_chars: 20_000,
          },
        });
        expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
        return (response.structuredContent as Record<string, any>).operation;
      };

      const recordTrace = await readTrace("shared-record-op");
      expect(recordTrace.mutations).toEqual([
        expect.objectContaining({ session_id: begun.session, operation: "record.create" }),
      ]);
      expect(recordTrace.records).toEqual([
        expect.objectContaining({ title: "first Session record", op_id: "shared-record-op" }),
      ]);
      expect(recordTrace.events).toEqual([
        expect.objectContaining({ session_id: begun.session, type: "record.created" }),
      ]);

      const progressTrace = await readTrace("shared-progress-op");
      expect(progressTrace.mutations).toEqual([
        expect.objectContaining({ session_id: begun.session, operation: "work.progress" }),
      ]);
      expect(progressTrace.progress).toEqual([
        expect.objectContaining({
          summary: "first Session progress",
          session_id: begun.session,
          op_id: "shared-progress-op",
        }),
      ]);
      expect(progressTrace.events).toEqual([
        expect.objectContaining({ session_id: begun.session, type: "work.progressed" }),
      ]);

      const projectTrace = await readTrace("shared-project-op");
      expect(projectTrace.mutations).toEqual([
        expect.objectContaining({ session_id: begun.session, operation: "project-update.publish" }),
      ]);
      expect(projectTrace.project_updates).toEqual([
        expect.objectContaining({
          summary: "first Session project update",
          session_id: begun.session,
          op_id: "shared-project-op",
        }),
      ]);
      expect(projectTrace.events).toEqual([
        expect.objectContaining({ session_id: begun.session, type: "project.update.published" }),
      ]);

      const missing = await profiles.memoryClient.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          op_id: "shared-record-op",
          session: unrelated.session,
        },
      });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toMatchObject({
        code: "OPERATION_NOT_FOUND",
        details: { reference: "shared-record-op" },
      });
    } finally {
      await profiles.close();
      service.close();
    }
  });
});
