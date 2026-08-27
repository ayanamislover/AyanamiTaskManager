import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

async function openFixture(code: string, name = `MCP surface ${code}`) {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-surface-v3-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  const project = await service.createProject({
    name,
    sourcePath: null,
    code,
  });
  const begun = await service.begin({
    projectCode: project.code,
    mode: "project",
    agentId: "surface-v3-agent",
    clientKind: "test",
  });
  const profiles = await connectProfiledClients(service, "mcp-surface-v3-test");
  return { service, project, session: String(begun.session), ...profiles };
}

async function closeFixture(fixture: Awaited<ReturnType<typeof openFixture>>) {
  await fixture.close();
  fixture.service.close();
}

function errorText(response: Awaited<ReturnType<Client["callTool"]>>): string {
  return String((response.content[0] as { text?: unknown } | undefined)?.text ?? "");
}

function errorDetails(response: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  const structured = response.structuredContent as { details?: Record<string, any> } | undefined;
  expect(structured?.details, errorText(response)).toBeDefined();
  return structured!.details!;
}

describe("MCP surface v3 parity", () => {
  it("returns bounded safe project candidates for PROJECT_NOT_FOUND", async () => {
    const fixture = await openFixture("CAH", "CrossAgent Hub");
    try {
      await fixture.service.createProject({ name: "Beta project", sourcePath: null, code: "BETA" });
      const response = await fixture.client.callTool({
        name: "atm_task_list",
        arguments: { project: "CrossAgent Hub" },
      });
      expect(response.isError).toBe(true);
      expect(errorText(response)).toContain("PROJECT_NOT_FOUND");
      const details = errorDetails(response);
      expect(details.did_you_mean).toBe("CAH");
      expect(details.candidates).toContainEqual({ code: "CAH", name: "CrossAgent Hub" });
      expect(details.candidates.length).toBeLessThanOrEqual(5);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("returns the same bounded public task_key candidates for WORK_ITEM_NOT_FOUND", async () => {
    const fixture = await openFixture("NFSMCP");
    try {
      const objective = await fixture.service.createObjectiveAsUser(
        fixture.project.code,
        "not-found-objective",
        { title: "NOT_FOUND candidates", description: "", definitionOfDone: [] },
      );
      const created = await fixture.service.createWorkItemsAsUser(
        fixture.project.code,
        "not-found-tasks",
        Array.from({ length: 7 }, (_, index) => ({
          clientRef: `task-${index + 1}`,
          objectiveId: objective.id,
          title: `Candidate task ${index + 1}`,
          type: "TASK",
          priority: "NORMAL",
          status: "READY" as const,
        })),
      );
      const response = await fixture.client.callTool({
        name: "atm_task_get",
        arguments: { project: fixture.project.code, task_key: `${fixture.project.code}-T-000I` },
      });

      expect(response.isError).toBe(true);
      expect(errorText(response)).toContain("WORK_ITEM_NOT_FOUND");
      const details = errorDetails(response);
      expect(details).toMatchObject({
        entity: "WORK_ITEM",
        did_you_mean: created.items[0]!.key,
        candidate_count: 7,
        candidate_scan_count: 7,
        candidate_scan_truncated: false,
        candidates_truncated: true,
      });
      expect(details.candidates).toHaveLength(5);
      for (const candidate of details.candidates) {
        expect(Object.keys(candidate).sort()).toEqual(["key", "status"]);
      }
      expect(JSON.stringify(details)).not.toContain(created.items[0]!.id);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("returns the same bounded public Session candidates for SESSION_NOT_FOUND", async () => {
    const fixture = await openFixture("NFSESS");
    try {
      for (let index = 0; index < 6; index += 1) {
        await fixture.service.begin({
          projectCode: fixture.project.code,
          mode: "project",
          agentId: `session-candidate-${index + 1}`,
          displayName: `Session Candidate ${index + 1}`,
          clientKind: "test",
        });
      }
      const missingId = `${fixture.session.slice(0, -1)}${fixture.session.endsWith("0") ? "1" : "0"}`;
      const response = await fixture.client.callTool({
        name: "atm_search",
        arguments: { project: fixture.project.code, query: `session:${missingId}` },
      });

      expect(response.isError).toBe(true);
      expect(errorText(response)).toContain("SESSION_NOT_FOUND");
      const details = errorDetails(response);
      expect(details).toMatchObject({ entity: "SESSION", did_you_mean: fixture.session });
      expect(details.candidates).toHaveLength(5);
      for (const candidate of details.candidates) {
        expect(Object.keys(candidate).sort()).toEqual(["connection_state", "id", "work_state"]);
      }
    } finally {
      await closeFixture(fixture);
    }
  });

  it("returns the same bounded public milestone_id candidates for MILESTONE_NOT_FOUND", async () => {
    const fixture = await openFixture("NFSMILE");
    try {
      const objective = await fixture.service.createObjectiveAsUser(
        fixture.project.code,
        "milestone-candidate-objective",
        { title: "Milestone candidates", description: "", definitionOfDone: [] },
      );
      const milestones = [];
      for (let index = 0; index < 7; index += 1) {
        milestones.push(
          await fixture.service.createMilestoneAsUser(
            fixture.project.code,
            `milestone-candidate-${index + 1}`,
            { objectiveId: objective.id, title: `Milestone Candidate ${index + 1}` },
          ),
        );
      }
      const expected = String(milestones[0]!.id);
      const missingId = `${expected.slice(0, -1)}${expected.endsWith("0") ? "1" : "0"}`;
      const response = await fixture.client.callTool({
        name: "atm_task_list",
        arguments: { project: fixture.project.code, milestone_id: missingId },
      });

      expect(response.isError).toBe(true);
      expect(errorText(response)).toContain("MILESTONE_NOT_FOUND");
      const details = errorDetails(response);
      expect(details).toMatchObject({ entity: "MILESTONE", did_you_mean: expected });
      expect(details.candidates).toHaveLength(5);
      for (const candidate of details.candidates) {
        expect(Object.keys(candidate).sort()).toEqual(["id", "status"]);
      }
    } finally {
      await closeFixture(fixture);
    }
  });

  it("does not fuzzy-route or persist an MCP task create with a missing milestone_id", async () => {
    const fixture = await openFixture("NFMWRITE");
    try {
      const objective = await fixture.service.createObjectiveAsUser(
        fixture.project.code,
        "write-candidate-objective",
        { title: "Write candidate", description: "", definitionOfDone: [] },
      );
      const milestone = await fixture.service.createMilestoneAsUser(
        fixture.project.code,
        "write-candidate-milestone",
        { objectiveId: objective.id, title: "Write Candidate Milestone" },
      );
      const expected = String(milestone.id);
      const missingId = `${expected.slice(0, -1)}${expected.endsWith("0") ? "1" : "0"}`;
      const opId = "mcp-missing-milestone-write";
      const response = await fixture.client.callTool({
        name: "atm_task_create",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: opId,
          items: [
            {
              client_ref: "must-not-create",
              objective_id: objective.id,
              milestone_id: missingId,
              title: "Must not fuzzy route",
              status: "READY",
            },
          ],
        },
      });

      expect(response.isError).toBe(true);
      expect(errorText(response)).toContain("MILESTONE_NOT_FOUND");
      expect(errorDetails(response)).toMatchObject({
        entity: "MILESTONE",
        did_you_mean: expected,
      });
      expect(await fixture.service.listWorkItems(fixture.project.code, { limit: 100 })).toEqual([]);
      await expect(
        fixture.service.getOperationTrace(fixture.project.code, opId, fixture.session),
      ).rejects.toMatchObject({
        code: "OPERATION_NOT_FOUND",
        details: { reference: opId },
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("validates milestone_id before implicit planning-root provisioning", async () => {
    const fixture = await openFixture("NFMROOT");
    try {
      const missingId = "00000000000000000000000000";
      const opId = "missing-milestone-before-root";
      const response = await fixture.client.callTool({
        name: "atm_task_create",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: opId,
          items: [
            {
              client_ref: "must-not-provision",
              milestone_id: missingId,
              title: "Must fail before planning root",
              status: "READY",
            },
          ],
        },
      });

      expect(response.isError).toBe(true);
      expect(errorText(response)).toContain("MILESTONE_NOT_FOUND");
      expect(errorDetails(response)).toEqual({
        entity: "MILESTONE",
        reference: missingId,
        did_you_mean: null,
        candidates: [],
        candidate_count: 0,
        candidate_scan_count: 0,
        candidate_scan_truncated: false,
        candidates_truncated: false,
      });
      expect(await fixture.service.listObjectives(fixture.project.code)).toEqual([]);
      expect(await fixture.service.listMilestones(fixture.project.code)).toEqual([]);
      expect(await fixture.service.listWorkItems(fixture.project.code, { limit: 100 })).toEqual([]);
      await expect(
        fixture.service.getOperationTrace(fixture.project.code, opId, fixture.session),
      ).rejects.toMatchObject({
        code: "OPERATION_NOT_FOUND",
        details: { reference: opId },
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("preserves closed-Session error priority before an empty-project milestone preflight", async () => {
    const fixture = await openFixture("NFCLOSE");
    try {
      await fixture.service.end(fixture.project.code, fixture.session, "close-before-preflight", {
        outcome: "completed",
        summary: "Close before invalid create",
        next: [],
        releaseClaims: true,
      });
      const response = await fixture.client.callTool({
        name: "atm_task_create",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: "closed-session-invalid-milestone",
          items: [
            {
              client_ref: "must-not-provision",
              milestone_id: "00000000000000000000000000",
              title: "Closed Session wins",
              status: "READY",
            },
          ],
        },
      });

      expect(response.isError).toBe(true);
      expect(errorText(response)).toContain(`SESSION_CLOSED: ${fixture.session}`);
      expect(await fixture.service.listObjectives(fixture.project.code)).toEqual([]);
      expect(await fixture.service.listMilestones(fixture.project.code)).toEqual([]);
      expect(await fixture.service.listWorkItems(fixture.project.code, { limit: 100 })).toEqual([]);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("returns current state and at most six recent changes for VERSION_CONFLICT", async () => {
    const fixture = await openFixture("MVERS");
    try {
      const objective = await fixture.service.createObjectiveAsUser(
        fixture.project.code,
        "surface-version-objective",
        { title: "Version conflict", description: "", definitionOfDone: [] },
      );
      const created = await fixture.service.createWorkItems(
        fixture.project.code,
        fixture.session,
        "surface-version-task",
        [
          {
            clientRef: "version-task",
            objectiveId: objective.id,
            title: "Versioned task",
            description: "d".repeat(50_000),
            type: "TASK",
            priority: "HIGH",
            status: "READY",
            checklist: [{ title: "Versioned checklist", evidenceRequired: false }],
          },
        ],
      );
      const task = created.items[0]!;
      await fixture.service.patchWorkItems(
        fixture.project.code,
        fixture.session,
        "surface-version-bump",
        [{ taskKey: task.key, expectedVersion: task.version, operation: "claim" }],
      );

      const response = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: "surface-version-conflict",
          items: [{ task_key: task.key, expected_version: task.version, operation: "start" }],
        },
      });
      expect(response.isError).toBe(true);
      expect(errorText(response)).toContain("VERSION_CONFLICT");
      expect(errorText(response).length).toBeLessThanOrEqual(6500);
      const details = errorDetails(response);
      expect(details).toMatchObject({
        entity: "WORK_ITEM",
        key: task.key,
        expected: task.version,
        actual: task.version + 1,
        changes_complete: false,
        current: {
          key: task.key,
          version: task.version + 1,
          status: "CLAIMED",
        },
      });
      expect(details.recent_changes.length).toBeGreaterThan(0);
      expect(details.recent_changes.length).toBeLessThanOrEqual(6);
      expect(details).not.toHaveProperty("truncated");
      expect(details.current.description).toHaveLength(50_000);

      const taskDetail = await fixture.service.getWorkItem(fixture.project.code, task.key);
      const checklist = taskDetail.checklist[0]!;
      await fixture.service.updateChecklist(
        fixture.project.code,
        fixture.session,
        "surface-version-checklist-bump",
        {
          checklistId: checklist.id,
          expectedVersion: checklist.version,
          status: "DOING",
        },
      );
      const checklistConflict = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: "surface-version-checklist-conflict",
          items: [
            {
              task_key: task.key,
              operation: "checklist_single",
              expected_version: checklist.version,
              checklist_items: [{ id: checklist.id, status: "DONE" }],
            },
          ],
        },
      });
      expect(checklistConflict.isError).toBe(true);
      const checklistDetails = errorDetails(checklistConflict);
      expect(checklistDetails).toMatchObject({
        entity: "CHECKLIST",
        key: checklist.id,
        expected: checklist.version,
        actual: checklist.version + 1,
        changes_complete: false,
        current: { id: checklist.id, status: "DOING", version: checklist.version + 1 },
      });
      expect(checklistDetails.recent_changes.length).toBeGreaterThan(0);
      expect(checklistDetails.recent_changes.length).toBeLessThanOrEqual(6);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("writes topic and subject_key and reads related records back", async () => {
    const fixture = await openFixture("MRECS");
    try {
      const write = (opId: string, title: string) =>
        fixture.client.callTool({
          name: "atm_record",
          arguments: {
            project: fixture.project.code,
            session: fixture.session,
            op_id: opId,
            kind: "FACT",
            title,
            summary: `${title} summary`,
            importance: "HIGH",
            topic: "surface-v3",
            subject_key: "mcp:surface-v3",
          },
        });
      const first = await write("surface-record-first", "First related record");
      expect(first.structuredContent).toMatchObject({
        entities: [expect.objectContaining({ entity_type: "RECORD" })],
      });
      const firstKey = String(
        (first.structuredContent as { entities: Array<{ key: string }> }).entities[0]!.key,
      );
      const second = await write("surface-record-second", "Second related record");
      expect(second.structuredContent).toMatchObject({
        entities: [expect.objectContaining({ entity_type: "RECORD" })],
      });
      const secondKey = String(
        (second.structuredContent as { entities: Array<{ key: string }> }).entities[0]!.key,
      );

      const exact = await fixture.client.callTool({
        name: "atm_search",
        arguments: {
          project: fixture.project.code,
          query: secondKey,
          field_mask: ["key", "importance", "topic", "subject_key", "related_records"],
        },
      });
      expect(exact.structuredContent).toMatchObject({
        exact: true,
        entity: {
          key: secondKey,
          importance: "HIGH",
          topic: "surface-v3",
          subject_key: "mcp:surface-v3",
          related_records: [firstKey],
        },
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("accepts structured completed entries and returns unlinked open work items", async () => {
    const fixture = await openFixture("MPROG");
    try {
      const objective = await fixture.service.createObjectiveAsUser(
        fixture.project.code,
        "surface-progress-objective",
        { title: "Progress links", description: "", definitionOfDone: [] },
      );
      const created = await fixture.service.createWorkItemsAsUser(
        fixture.project.code,
        "surface-progress-tasks",
        [
          {
            clientRef: "linked",
            objectiveId: objective.id,
            title: "Linked task",
            type: "TASK",
            priority: "NORMAL",
            status: "READY",
          },
          {
            clientRef: "open",
            objectiveId: objective.id,
            title: "Open task",
            type: "TASK",
            priority: "NORMAL",
            status: "READY",
          },
        ],
      );
      const response = await fixture.client.callTool({
        name: "atm_progress_add",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: "surface-progress-linked",
          scope: "project",
          summary: "Mixed linked and unlinked completions",
          completed: [
            { text: "Delivered linked task", work_item_key: created.items[0]!.key },
            "Unlinked release note",
          ],
          health: "AT_RISK",
          blocker: "Awaiting external acceptance",
          next: ["Resolve acceptance"],
          evidence: [{ kind: "git_sha", value: "abc123" }],
        },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        entities: [expect.objectContaining({ entity_type: "PROJECT_UPDATE" })],
      });
      const trace = await fixture.client.callTool({
        name: "atm_search",
        arguments: { project: fixture.project.code, query: "op:surface-progress-linked" },
      });
      expect(trace.structuredContent).toMatchObject({
        exact: true,
        operation: {
          project_updates: [
            expect.objectContaining({
              health: "AT_RISK",
              risks: ["Awaiting external acceptance"],
              next: ["Resolve acceptance"],
              evidence: [{ kind: "git_sha", value: "abc123" }],
            }),
          ],
        },
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("creates and atomically assigns a task through assignee_agent_id", async () => {
    const fixture = await openFixture("MASSN");
    try {
      const invalid = await fixture.client.callTool({
        name: "atm_task_create",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: "surface-create-empty-assignee",
          items: [{ client_ref: "invalid", title: "Invalid assignee", assignee_agent_id: "   " }],
        },
      });
      expect(invalid.isError).toBe(true);
      const response = await fixture.client.callTool({
        name: "atm_task_create",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: "surface-create-assigned",
          items: [
            {
              client_ref: "assigned-task",
              title: "Atomically assigned task",
              status: "READY",
              assignee_agent_id: " surface-v3-agent ",
            },
          ],
        },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        entities: [expect.objectContaining({ entity_type: "WORK_ITEM" })],
      });
      const key = String(
        (response.structuredContent as { entities: Array<{ key: string }> }).entities[0]!.key,
      );
      expect(await fixture.service.getWorkItem(fixture.project.code, key, "context")).toMatchObject(
        {
          assigneeAgentId: "surface-v3-agent",
        },
      );
      expect(await fixture.service.listWorkItems(fixture.project.code, {})).toHaveLength(1);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("applies the restored core orchestration fields through real SQLite", async () => {
    const fixture = await openFixture("MCORE");
    try {
      const objective = await fixture.service.createObjectiveAsUser(
        fixture.project.code,
        "restored-core-objective",
        { title: "Restored core", description: "", definitionOfDone: [] },
      );
      const milestone = await fixture.service.createMilestoneAsUser(
        fixture.project.code,
        "restored-core-milestone",
        { objectiveId: objective.id, title: "Restored milestone" },
      );
      const seed = await fixture.service.createWorkItemsAsUser(
        fixture.project.code,
        "restored-core-seed",
        [
          {
            clientRef: "seed",
            objectiveId: objective.id,
            title: "Discovery seed",
            type: "TASK",
            priority: "NORMAL",
            status: "READY",
          },
        ],
      );

      const begun = await fixture.client.callTool({
        name: "atm_begin",
        arguments: {
          project_code: fixture.project.code,
          op_id: "restored-core-begin",
          mode: "project",
          agent_id: "restored-agent",
          title: "Restored title",
          display_name: "Restored Agent",
          client_kind: "integration-test",
          signals: {
            expected_minutes: 20,
            subtask_count: 2,
            multi_session: true,
            multi_agent: true,
            has_dependencies: true,
            needs_evidence: true,
            has_target_date: true,
          },
          creation_reason: "Exercise restored core MCP inputs",
          brief: "none",
          max_chars: 800,
          allow_project_create: false,
        },
      });
      expect(begun.isError, JSON.stringify(begun.content)).not.toBe(true);
      const restoredSession = String((begun.structuredContent as Record<string, unknown>).session);
      expect(restoredSession).toMatch(/^01/u);

      const created = await fixture.client.callTool({
        name: "atm_task_create",
        arguments: {
          project: fixture.project.code,
          session: restoredSession,
          op_id: "restored-core-create",
          items: [
            {
              client_ref: "source",
              objective_id: objective.id,
              milestone_id: milestone.id,
              discovered_from: seed.items[0]!.key,
              title: "Restored source searchable",
              description: "Full restored create fields",
              status: "READY",
              assignee_agent_id: "restored-agent",
              checklist: [{ title: "Weighted acceptance", weight: 3 }],
              weight: 5,
              target_date: "2026-09-01",
            },
            {
              client_ref: "child",
              objective_id: objective.id,
              milestone_id: milestone.id,
              parent_ref: "source",
              discovered_from_ref: "source",
              title: "Restored child searchable",
              description: "Filtered through task_list",
              status: "READY",
              assignee_agent_id: "restored-agent",
              weight: 2,
            },
          ],
        },
      });
      expect(created.isError, JSON.stringify(created.content)).not.toBe(true);
      const createdItems = (
        created.structuredContent as {
          entities: Array<{ entity_type: string; key: string; version: number }>;
        }
      ).entities.filter((entity) => entity.entity_type === "WORK_ITEM");
      const sourceKey = createdItems[0]!.key;
      const childKey = createdItems[1]!.key;
      const source = await fixture.service.getWorkItem(fixture.project.code, sourceKey);
      const child = await fixture.service.getWorkItem(fixture.project.code, childKey);
      expect(source).toMatchObject({
        objectiveId: objective.id,
        milestoneId: milestone.id,
        discoveredFrom: seed.items[0]!.key,
        weight: 5,
        targetDate: "2026-09-01",
        assigneeAgentId: "restored-agent",
        checklist: [expect.objectContaining({ weight: 3 })],
      });
      expect(child).toMatchObject({
        parentKey: sourceKey,
        discoveredFrom: sourceKey,
        milestoneId: milestone.id,
      });

      const listed = await fixture.client.callTool({
        name: "atm_task_list",
        arguments: {
          project: fixture.project.code,
          status: "READY",
          owner: "restored-agent",
          parent_key: sourceKey,
          milestone_id: milestone.id,
          query: "Restored child",
          limit: 1,
          cursor: "0",
          view: "context",
          field_mask: ["key", "title", "description_preview"],
          max_chars: 4000,
        },
      });
      expect(listed.structuredContent).toMatchObject({
        returned_count: 1,
        items: [expect.objectContaining({ key: childKey, title: "Restored child searchable" })],
      });
      const reconcile = await fixture.client.callTool({
        name: "atm_task_list",
        arguments: {
          project: fixture.project.code,
          view: "reconcile",
          include_active: true,
          limit: 1,
          field_mask: ["task_key", "classification"],
          max_chars: 4000,
        },
      });
      expect(reconcile.isError, JSON.stringify(reconcile.content)).not.toBe(true);

      const patched = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: fixture.project.code,
          session: restoredSession,
          op_id: "restored-core-edit",
          items: [
            {
              task_key: childKey,
              expected_version: child.version,
              operation: "edit",
              assignee_agent_id: null,
              target_date: "2026-09-02",
              parent_key: null,
            },
          ],
        },
      });
      expect(patched.isError, JSON.stringify(patched.content)).not.toBe(true);
      expect(await fixture.service.getWorkItem(fixture.project.code, childKey)).toMatchObject({
        assigneeAgentId: null,
        targetDate: "2026-09-02",
        parentKey: null,
      });

      const sourceBeforeClaim = await fixture.service.getWorkItem(fixture.project.code, sourceKey);
      const claimed = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: fixture.project.code,
          session: restoredSession,
          op_id: "restored-core-claim",
          items: [
            {
              task_key: sourceKey,
              expected_version: sourceBeforeClaim.version,
              operation: "claim",
            },
          ],
        },
      });
      expect(claimed.isError, JSON.stringify(claimed.content)).not.toBe(true);
      const ended = await fixture.client.callTool({
        name: "atm_end",
        arguments: {
          project: fixture.project.code,
          session: restoredSession,
          op_id: "restored-core-end",
          outcome: "paused",
          summary: "Preserve claim for handoff",
          next: ["Continue restored test"],
          release_claims: false,
        },
      });
      expect(ended.isError, JSON.stringify(ended.content)).not.toBe(true);
      expect(await fixture.service.getWorkItem(fixture.project.code, sourceKey)).toMatchObject({
        status: "CLAIMED",
        claimedBySessionId: restoredSession,
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("applies restored memory fields through progress, records, search and delta", async () => {
    const fixture = await openFixture("MMEM");
    try {
      const objective = await fixture.service.createObjectiveAsUser(
        fixture.project.code,
        "restored-memory-objective",
        { title: "Restored memory", description: "", definitionOfDone: [] },
      );
      const created = await fixture.service.createWorkItemsAsUser(
        fixture.project.code,
        "restored-memory-task",
        [
          {
            clientRef: "progress",
            objectiveId: objective.id,
            title: "Restored memory task",
            type: "TASK",
            priority: "NORMAL",
            status: "READY",
          },
        ],
      );
      const taskKey = created.items[0]!.key;
      const progress = await fixture.client.callTool({
        name: "atm_progress_add",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: "restored-memory-progress",
          scope: "task",
          task_key: taskKey,
          summary: "Persist the restored percent",
          percent: 37,
        },
      });
      expect(progress.isError, JSON.stringify(progress.content)).not.toBe(true);
      expect(await fixture.service.getWorkItem(fixture.project.code, taskKey)).toMatchObject({
        reportedProgress: 40,
      });

      const projectPercent = await fixture.client.callTool({
        name: "atm_progress_add",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: "restored-memory-invalid-project-percent",
          scope: "project",
          summary: "Must not silently drop percent",
          percent: 37,
        },
      });
      expect(projectPercent.isError).toBe(true);
      expect(errorText(projectPercent)).toContain("percent");

      const firstRecord = await fixture.client.callTool({
        name: "atm_record",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: "restored-memory-record-one",
          kind: "FACT",
          title: "Restored searchable one",
          summary: "Restored scope one",
          scope: "WORK_ITEM",
          work_item_key: taskKey,
        },
      });
      const secondRecord = await fixture.client.callTool({
        name: "atm_record",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: "restored-memory-record-two",
          kind: "FACT",
          title: "Restored searchable two",
          summary: "Restored scope two",
          scope: "WORK_ITEM",
          work_item_key: taskKey,
        },
      });
      expect(firstRecord.isError, JSON.stringify(firstRecord.content)).not.toBe(true);
      expect(secondRecord.isError, JSON.stringify(secondRecord.content)).not.toBe(true);
      const firstKey = String(
        (firstRecord.structuredContent as { entities: Array<{ key: string }> }).entities[0]!.key,
      );
      expect(await fixture.service.getRecord(fixture.project.code, firstKey)).toMatchObject({
        scope: "WORK_ITEM",
      });

      const exactTrace = await fixture.client.callTool({
        name: "atm_search",
        arguments: {
          project: fixture.project.code,
          op_id: "restored-memory-progress",
          session: fixture.session,
          limit: 1,
          field_mask: ["op_id", "progress"],
        },
      });
      expect(exactTrace.structuredContent).toMatchObject({
        exact: true,
        operation: {
          op_id: "restored-memory-progress",
          progress: [expect.objectContaining({ percent: 37, task_key: taskKey })],
        },
      });
      const limited = await fixture.client.callTool({
        name: "atm_search",
        arguments: {
          project: fixture.project.code,
          query: "Restored searchable",
          limit: 1,
        },
      });
      expect(limited.structuredContent).toMatchObject({
        exact: false,
        hits: [expect.any(Object)],
        next_cursor: expect.stringMatching(/^s1\./u),
        has_more: true,
      });

      const delta = await fixture.client.callTool({
        name: "atm_delta",
        arguments: {
          project: fixture.project.code,
          since_seq: 0,
          limit: 1,
          types: ["work.created"],
          max_chars: 1000,
        },
      });
      expect(delta.isError, JSON.stringify(delta.content)).not.toBe(true);
      expect(delta.structuredContent).toMatchObject({
        requested_limit: 1,
        returned_count: 1,
        events: [expect.objectContaining({ type: "work.created" })],
      });
      expect(JSON.stringify(delta.structuredContent).length).toBeLessThanOrEqual(1000);
    } finally {
      await closeFixture(fixture);
    }
  });
});
