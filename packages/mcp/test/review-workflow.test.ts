import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { createAyanamiMcpServer } from "../src/index.js";
import { publishedOperationVariant } from "./published-operation-schema.js";

const roots: string[] = [];

function dereferenceSchema(schema: Record<string, any>, root: Record<string, any>) {
  if (typeof schema?.$ref !== "string" || !schema.$ref.startsWith("#/")) return schema;
  return schema.$ref
    .slice(2)
    .split("/")
    .reduce((value: any, segment: string) => value?.[segment], root);
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

async function openReviewFixture(code: string, reviewChecklist = false) {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-review-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  const project = await service.createProject({ name: "MCP Review", sourcePath: null, code });
  const primary = await service.begin({
    projectCode: project.code,
    agentId: "author-agent",
    role: "PRIMARY",
  });
  const objective = await service.createObjective(project.code, primary.session, {
    title: "MCP Review workflow",
    description: "",
    definitionOfDone: [],
  });
  const created = await service.createWorkItems(project.code, primary.session, `${code}-create`, [
    {
      clientRef: "parent",
      objectiveId: objective.id,
      title: "候选实现",
      type: "TASK",
      priority: "HIGH",
      status: "IN_PROGRESS",
      checklist: [{ title: "异构 Review 通过", evidenceRequired: true }],
    },
    {
      clientRef: "review",
      objectiveId: objective.id,
      parentRef: "parent",
      title: "独立 Review",
      type: "REVIEW",
      priority: "CRITICAL",
      status: "READY",
      assigneeAgentId: "review-agent",
      checklist: reviewChecklist ? [{ title: "Review 自检", evidenceRequired: false }] : [],
    },
  ]);
  const parent = await service.getWorkItem(project.code, created.items[0]!.key, "full");
  const review = await service.getWorkItem(project.code, created.items[1]!.key, "full");
  const server = createAyanamiMcpServer(service, { profile: "actions" });
  const client = new Client({ name: "mcp-review-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { service, project, primary: primary.session, parent, review, server, client };
}

async function closeReviewFixture(fixture: Awaited<ReturnType<typeof openReviewFixture>>) {
  await Promise.all([fixture.client.close(), fixture.server.close()]);
  fixture.service.close();
}

async function requestReview(
  fixture: Awaited<ReturnType<typeof openReviewFixture>>,
  opId: string,
  hashes: Record<string, string>,
) {
  return fixture.client.callTool({
    name: "atm_task_patch",
    arguments: {
      project: fixture.project.code,
      session: fixture.primary,
      op_id: opId,
      items: [
        {
          task_key: fixture.review.key,
          expected_version: fixture.review.version,
          operation: "review_request",
          parent_checklist_id: fixture.parent.checklist[0]!.id,
          expected_parent_checklist_version: fixture.parent.checklist[0]!.version,
          candidate_hashes: hashes,
        },
      ],
    },
  });
}

async function claimAndStartReview(fixture: Awaited<ReturnType<typeof openReviewFixture>>) {
  const reviewer = await fixture.service.begin({
    projectCode: fixture.project.code,
    agentId: "review-agent",
    role: "REVIEWER",
  });
  const claimed = await fixture.client.callTool({
    name: "atm_task_patch",
    arguments: {
      project: fixture.project.code,
      session: reviewer.session,
      op_id: `${fixture.project.code}-claim`,
      items: [
        {
          task_key: fixture.review.key,
          expected_version: fixture.review.version,
          operation: "claim",
        },
      ],
    },
  });
  const claimedVersion = (claimed.structuredContent as { items: Array<{ version: number }> })
    .items[0]!.version;
  const started = await fixture.client.callTool({
    name: "atm_task_patch",
    arguments: {
      project: fixture.project.code,
      session: reviewer.session,
      op_id: `${fixture.project.code}-start`,
      items: [
        {
          task_key: fixture.review.key,
          expected_version: claimedVersion,
          operation: "start",
        },
      ],
    },
  });
  return {
    session: reviewer.session,
    version: (started.structuredContent as { items: Array<{ version: number }> }).items[0]!.version,
  };
}

describe("MCP first-class Review workflow", () => {
  it("returns rich conflict details when Review request races its parent checklist", async () => {
    const fixture = await openReviewFixture("MRVX");
    try {
      const checklist = fixture.parent.checklist[0]!;
      await fixture.service.updateChecklist(
        fixture.project.code,
        fixture.primary,
        "review-conflict-checklist-bump",
        {
          checklistId: checklist.id,
          expectedVersion: checklist.version,
          status: "DOING",
        },
      );
      const response = await requestReview(fixture, "review-request-version-conflict", {
        git_head: "a".repeat(40),
      });
      expect(response.isError).toBe(true);
      const text = String((response.content[0] as { text?: unknown } | undefined)?.text ?? "");
      expect(text).toContain("VERSION_CONFLICT");
      expect(text).not.toContain("MCP_DETAILS=");
      const details = (response.structuredContent as { details: Record<string, any> }).details;
      expect(details).toMatchObject({
        entity: "CHECKLIST",
        key: checklist.id,
        expected: checklist.version,
        actual: checklist.version + 1,
        changes_complete: false,
        current: { id: checklist.id, status: "DOING", version: checklist.version + 1 },
      });
      expect(details.recent_changes.length).toBeGreaterThan(0);
      expect(details.recent_changes.length).toBeLessThanOrEqual(6);
    } finally {
      await closeReviewFixture(fixture);
    }
  });

  it("publishes the Review contract and atomically submits APPROVED", async () => {
    const fixture = await openReviewFixture("MRVA");
    try {
      const listed = await fixture.client.listTools();
      expect(listed.tools).toHaveLength(1);
      const schema = listed.tools.find((tool) => tool.name === "atm_task_patch")?.inputSchema as {
        properties?: Record<string, any>;
      };
      const requestVariant = publishedOperationVariant(schema, "review_request");
      const submitVariant = publishedOperationVariant(schema, "review_submit");
      expect(requestVariant.properties).toHaveProperty("candidate_hashes");
      expect(submitVariant.properties).toHaveProperty("verdict");
      expect(
        dereferenceSchema(requestVariant.properties.parent_checklist_id, schema),
      ).toMatchObject({ type: "string" });
      expect(
        dereferenceSchema(requestVariant.properties.expected_parent_checklist_version, schema),
      ).toMatchObject({ type: "integer" });
      expect(dereferenceSchema(submitVariant.properties.request_key, schema)).toMatchObject({
        type: "string",
      });
      expect(dereferenceSchema(requestVariant.properties.candidate_hashes, schema)).toMatchObject({
        type: "object",
        additionalProperties: { type: "string" },
      });
      expect(dereferenceSchema(submitVariant.properties.verdict, schema)).toMatchObject({
        enum: ["APPROVED", "CHANGES_REQUESTED"],
      });
      expect(requestVariant.required).toEqual(
        expect.arrayContaining([
          "parent_checklist_id",
          "expected_parent_checklist_version",
          "candidate_hashes",
        ]),
      );

      const invalid = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: fixture.project.code,
          session: fixture.primary,
          op_id: "invalid-review-request",
          items: [
            {
              task_key: fixture.review.key,
              expected_version: fixture.review.version,
              operation: "review_request",
              request_key: "forbidden-submit-field",
            },
          ],
        },
      });
      expect(invalid.isError).toBe(true);
      const invalidText = JSON.stringify(invalid.content);
      expect(invalidText).toContain("items");

      const hashes = { WorkTree: "B".repeat(64), git_head: "A".repeat(40) };
      const requested = await requestReview(fixture, "mcp-review-request", hashes);
      expect(requested.isError, JSON.stringify(requested.content)).not.toBe(true);
      expect(requested.structuredContent).toMatchObject({
        op_id: "mcp-review-request",
        review_request: {
          request_key: "MRVA-RR-0001",
          review_task_key: fixture.review.key,
          parent_task_key: fixture.parent.key,
          expected_candidate_hashes: [
            { name: "git_head", value: "a".repeat(40) },
            { name: "worktree", value: "b".repeat(64) },
          ],
        },
      });
      const reviewer = await claimAndStartReview(fixture);
      const submitted = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: fixture.project.code,
          session: reviewer.session,
          op_id: "mcp-review-approved",
          items: [
            {
              task_key: fixture.review.key,
              expected_version: reviewer.version,
              operation: "review_submit",
              request_key: "MRVA-RR-0001",
              verdict: "APPROVED",
              candidate_hashes: { git_head: hashes.git_head, WorkTree: hashes.WorkTree },
              evidence: [{ kind: "test_result", value: "MCP review gate: 42 passed" }],
            },
          ],
        },
      });
      expect(submitted.isError, JSON.stringify(submitted.content)).not.toBe(true);
      expect(submitted.structuredContent).toMatchObject({
        op_id: "mcp-review-approved",
        review_submission: {
          request_key: "MRVA-RR-0001",
          submission_key: "MRVA-RS-0001",
          record_key: "MRVA-R-001",
          verdict: "APPROVED",
          review_task: { task_key: fixture.review.key, status: "DONE" },
          parent_checklist: { id: fixture.parent.checklist[0]!.id, status: "DONE" },
          parent_task: { task_key: fixture.parent.key, status: "IN_PROGRESS" },
        },
      });
      expect(await fixture.service.getRecord(fixture.project.code, "MRVA-R-001")).toMatchObject({
        scope: "REVIEW_AUDIT",
        workItemKey: fixture.review.key,
      });
    } finally {
      await closeReviewFixture(fixture);
    }
  });

  it("rolls back identity/hash failures and keeps CHANGES_REQUESTED idempotent", async () => {
    const fixture = await openReviewFixture("MRVC");
    try {
      const hashes = { git_head: "c".repeat(40) };
      const requested = await requestReview(fixture, "changes-request", hashes);
      expect(requested.isError, JSON.stringify(requested.content)).not.toBe(true);
      const reviewer = await claimAndStartReview(fixture);
      const intruder = await fixture.service.begin({
        projectCode: fixture.project.code,
        agentId: "intruder-reviewer",
        role: "REVIEWER",
      });
      const base = {
        project: fixture.project.code,
        op_id: "review-changes-retry",
        items: [
          {
            task_key: fixture.review.key,
            expected_version: reviewer.version,
            operation: "review_submit",
            request_key: "MRVC-RR-0001",
            verdict: "CHANGES_REQUESTED",
            candidate_hashes: hashes,
            evidence: [{ kind: "test_result", value: "blocking issue found" }],
          },
        ],
      };

      const wrongIdentity = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: { ...base, session: intruder.session, op_id: "wrong-reviewer" },
      });
      expect(wrongIdentity.isError).toBe(true);
      expect(JSON.stringify(wrongIdentity.content)).toContain("REVIEW_IDENTITY_MISMATCH");

      const wrongHash = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: {
          ...base,
          session: reviewer.session,
          items: [{ ...base.items[0], candidate_hashes: { git_head: "d".repeat(40) } }],
        },
      });
      expect(wrongHash.isError).toBe(true);
      expect(JSON.stringify(wrongHash.content)).toContain("CANDIDATE_HASH_MISMATCH");
      expect(await fixture.service.listRecords(fixture.project.code)).toHaveLength(0);
      expect(
        (await fixture.service.getReviewRequest(fixture.project.code, "MRVC-RR-0001")).submission,
      ).toBeNull();

      const submitted = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: { ...base, session: reviewer.session },
      });
      expect(submitted.isError, JSON.stringify(submitted.content)).not.toBe(true);
      expect(submitted.structuredContent).toMatchObject({
        op_id: "review-changes-retry",
        review_submission: {
          verdict: "CHANGES_REQUESTED",
          parent_checklist: { status: "TODO", version: 0 },
          review_task: { status: "DONE" },
        },
      });
      const replayed = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: { ...base, session: reviewer.session },
      });
      expect(replayed.structuredContent).toEqual(submitted.structuredContent);

      const conflict = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: {
          ...base,
          session: reviewer.session,
          items: [{ ...base.items[0], verdict: "APPROVED" }],
        },
      });
      expect(conflict.isError).toBe(true);
      expect(JSON.stringify(conflict.content)).toContain("IDEMPOTENCY_CONFLICT");
      expect(await fixture.service.listRecords(fixture.project.code)).toHaveLength(1);
    } finally {
      await closeReviewFixture(fixture);
    }
  });

  it("rolls back a completion-gate failure and allows the same op_id after checklist repair", async () => {
    const fixture = await openReviewFixture("MRVG", true);
    try {
      const hashes = { git_head: "e".repeat(40) };
      const requested = await requestReview(fixture, "gate-request", hashes);
      expect(requested.isError, JSON.stringify(requested.content)).not.toBe(true);
      const reviewer = await claimAndStartReview(fixture);
      const submission = {
        project: fixture.project.code,
        session: reviewer.session,
        op_id: "gate-submit-retry",
        items: [
          {
            task_key: fixture.review.key,
            expected_version: reviewer.version,
            operation: "review_submit",
            request_key: "MRVG-RR-0001",
            verdict: "APPROVED",
            candidate_hashes: hashes,
            evidence: [{ kind: "test_result", value: "review checklist repaired" }],
          },
        ],
      };
      const blocked = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: submission,
      });
      expect(blocked.isError).toBe(true);
      expect(JSON.stringify(blocked.content)).toContain("COMPLETION_GATE_FAILED");
      expect(await fixture.service.listRecords(fixture.project.code)).toHaveLength(0);
      expect(
        (await fixture.service.getReviewRequest(fixture.project.code, "MRVG-RR-0001")).submission,
      ).toBeNull();
      expect(
        await fixture.service.getWorkItem(fixture.project.code, fixture.review.key),
      ).toMatchObject({ status: "IN_PROGRESS", version: reviewer.version });

      const review = await fixture.service.getWorkItem(
        fixture.project.code,
        fixture.review.key,
        "full",
      );
      const checked = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: fixture.project.code,
          session: reviewer.session,
          op_id: "gate-checklist-repair",
          items: [
            {
              task_key: fixture.review.key,
              operation: "checklist_single",
              expected_version: review.checklist[0]!.version,
              checklist_items: [
                {
                  id: review.checklist[0]!.id,
                  status: "DONE",
                  evidence: [{ kind: "test_result", value: "review self-check passed" }],
                },
              ],
            },
          ],
        },
      });
      const repairedVersion = (checked.structuredContent as { task_version: number }).task_version;
      const repaired = await fixture.client.callTool({
        name: "atm_task_patch",
        arguments: {
          ...submission,
          items: [{ ...submission.items[0], expected_version: repairedVersion }],
        },
      });
      expect(repaired.isError, JSON.stringify(repaired.content)).not.toBe(true);
      expect(repaired.structuredContent).toMatchObject({
        op_id: "gate-submit-retry",
        review_submission: {
          verdict: "APPROVED",
          review_task: { status: "DONE" },
          parent_checklist: { status: "DONE" },
        },
      });
    } finally {
      await closeReviewFixture(fixture);
    }
  });
});
