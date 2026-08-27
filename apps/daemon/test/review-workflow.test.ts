import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 50,
    });
});

async function openRestReview(code: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-rest-review-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await service.createProject({ name: "REST Review", sourcePath: null, code });
  const primary = await service.begin({
    projectCode: project.code,
    agentId: "rest-author",
    role: "PRIMARY",
  });
  const objective = await service.createObjective(project.code, primary.session, {
    title: "REST Review",
    description: "",
    definitionOfDone: [],
  });
  const created = await service.createWorkItems(
    project.code,
    primary.session,
    "rest-review-tasks",
    [
      {
        clientRef: "parent",
        objectiveId: objective.id,
        title: "REST candidate",
        type: "TASK",
        priority: "HIGH",
        status: "IN_PROGRESS",
        checklist: [{ title: "Review approved", evidenceRequired: true }],
      },
      {
        clientRef: "review",
        objectiveId: objective.id,
        parentRef: "parent",
        title: "REST independent review",
        type: "REVIEW",
        priority: "CRITICAL",
        status: "READY",
        assigneeAgentId: "rest-reviewer",
      },
    ],
  );
  const parent = await service.getWorkItem(project.code, created.items[0]!.key, "full");
  const review = await service.getWorkItem(project.code, created.items[1]!.key, "full");
  const app = await buildAyanamiServer({ service, token: "local-secret" });
  return { service, app, project, primary: primary.session, parent, review };
}

async function createRequestViaRest(ctx: Awaited<ReturnType<typeof openRestReview>>, opId: string) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/projects/${ctx.project.code}/reviews/requests`,
    headers: { authorization: "Bearer local-secret" },
    payload: {
      session: ctx.primary,
      opId,
      reviewTaskKey: ctx.review.key,
      expectedReviewTaskVersion: ctx.review.version,
      parentChecklistId: ctx.parent.checklist[0]!.id,
      expectedParentChecklistVersion: ctx.parent.checklist[0]!.version,
      expectedCandidateHashes: [{ name: "git_head", value: "a".repeat(40) }],
    },
  });
}

describe("REST 一等 Review verdict", () => {
  it("创建/读取 request，并由 REVIEWER 原子提交 APPROVED verdict", async () => {
    const ctx = await openRestReview("RVRST");
    try {
      const requestResponse = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/projects/${ctx.project.code}/reviews/requests`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: ctx.primary,
          opId: "rest-review-request",
          reviewTaskKey: ctx.review.key,
          expectedReviewTaskVersion: ctx.review.version,
          parentChecklistId: ctx.parent.checklist[0]!.id,
          expectedParentChecklistVersion: ctx.parent.checklist[0]!.version,
          expectedCandidateHashes: [{ name: "git_head", value: "a".repeat(40) }],
        },
      });
      expect(requestResponse.statusCode).toBe(201);
      expect(requestResponse.json()).toMatchObject({
        opId: "rest-review-request",
        request: { key: "RVRST-RR-0001", submission: null },
      });
      const requestKey = requestResponse.json().request.key as string;
      const readResponse = await ctx.app.inject({
        method: "GET",
        url: `/api/v1/projects/${ctx.project.code}/reviews/requests/${requestKey}`,
        headers: { authorization: "Bearer local-secret" },
      });
      expect(readResponse.statusCode).toBe(200);
      expect(readResponse.json()).toMatchObject({ key: requestKey, reviewTaskKey: ctx.review.key });

      const reviewer = await ctx.service.begin({
        projectCode: ctx.project.code,
        agentId: "rest-reviewer",
        role: "REVIEWER",
      });
      const claimed = await ctx.service.patchWorkItems(
        ctx.project.code,
        reviewer.session,
        "rest-review-claim",
        [
          {
            taskKey: ctx.review.key,
            expectedVersion: ctx.review.version,
            operation: "claim",
          },
        ],
      );
      const started = await ctx.service.patchWorkItems(
        ctx.project.code,
        reviewer.session,
        "rest-review-start",
        [
          {
            taskKey: ctx.review.key,
            expectedVersion: claimed.items[0]!.version,
            operation: "start",
          },
        ],
      );
      const submitResponse = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/projects/${ctx.project.code}/reviews/requests/${requestKey}/submit`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: reviewer.session,
          opId: "rest-review-approved",
          expectedReviewTaskVersion: started.items[0]!.version,
          verdict: "APPROVED",
          reviewedHashes: [{ name: "git_head", value: "A".repeat(40) }],
          evidence: [{ kind: "test_result", value: "REST review gate passed" }],
        },
      });
      expect(submitResponse.statusCode).toBe(200);
      expect(submitResponse.json()).toMatchObject({
        requestKey,
        submissionKey: "RVRST-RS-0001",
        recordKey: "RVRST-R-001",
        verdict: "APPROVED",
        reviewTask: { status: "DONE" },
        parentChecklist: { status: "DONE" },
        parentTask: { status: "IN_PROGRESS" },
      });
    } finally {
      await ctx.app.close();
      ctx.service.close();
    }
  });

  it("Review 身份、已提交、关闭任务/checklist 与绑定错误都返回可操作 4xx 而非 500", async () => {
    const identity = await openRestReview("RVIDERR");
    try {
      const request = await createRequestViaRest(identity, "identity-request");
      const requestKey = request.json().request.key as string;
      const intruder = await identity.service.begin({
        projectCode: identity.project.code,
        agentId: "intruder-reviewer",
        role: "REVIEWER",
      });
      const identityFailure = await identity.app.inject({
        method: "POST",
        url: `/api/v1/projects/${identity.project.code}/reviews/requests/${requestKey}/submit`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: intruder.session,
          opId: "identity-failure",
          expectedReviewTaskVersion: identity.review.version,
          verdict: "APPROVED",
          reviewedHashes: [{ name: "git_head", value: "a".repeat(40) }],
          evidence: [{ kind: "test_result", value: "tests passed" }],
        },
      });
      expect(identityFailure.statusCode).toBe(409);
      expect(identityFailure.json()).toMatchObject({
        error: { code: "REVIEW_IDENTITY_MISMATCH" },
      });
      const roleFailure = await identity.app.inject({
        method: "POST",
        url: `/api/v1/projects/${identity.project.code}/reviews/requests/${requestKey}/submit`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: identity.primary,
          opId: "role-failure",
          expectedReviewTaskVersion: identity.review.version,
          verdict: "APPROVED",
          reviewedHashes: [{ name: "git_head", value: "a".repeat(40) }],
          evidence: [{ kind: "test_result", value: "tests passed" }],
        },
      });
      expect(roleFailure.statusCode).toBe(403);
      expect(roleFailure.json()).toMatchObject({ error: { code: "REVIEWER_REQUIRED" } });
      const assigned = await identity.service.begin({
        projectCode: identity.project.code,
        agentId: "rest-reviewer",
        role: "REVIEWER",
      });
      const claimed = await identity.service.patchWorkItems(
        identity.project.code,
        assigned.session,
        "identity-valid-claim",
        [
          {
            taskKey: identity.review.key,
            expectedVersion: identity.review.version,
            operation: "claim",
          },
        ],
      );
      const started = await identity.service.patchWorkItems(
        identity.project.code,
        assigned.session,
        "identity-valid-start",
        [
          {
            taskKey: identity.review.key,
            expectedVersion: claimed.items[0]!.version,
            operation: "start",
          },
        ],
      );
      const hashFailure = await identity.app.inject({
        method: "POST",
        url: `/api/v1/projects/${identity.project.code}/reviews/requests/${requestKey}/submit`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: assigned.session,
          opId: "hash-failure",
          expectedReviewTaskVersion: started.items[0]!.version,
          verdict: "APPROVED",
          reviewedHashes: [{ name: "git_head", value: "b".repeat(40) }],
          evidence: [{ kind: "test_result", value: "tests passed" }],
        },
      });
      expect(hashFailure.statusCode).toBe(422);
      expect(hashFailure.json()).toMatchObject({ error: { code: "CANDIDATE_HASH_MISMATCH" } });
    } finally {
      await identity.app.close();
      identity.service.close();
    }

    const submitted = await openRestReview("RVSUBERR");
    try {
      const request = await createRequestViaRest(submitted, "submitted-request");
      const requestKey = request.json().request.key as string;
      const reviewer = await submitted.service.begin({
        projectCode: submitted.project.code,
        agentId: "rest-reviewer",
        role: "REVIEWER",
      });
      const claimed = await submitted.service.patchWorkItems(
        submitted.project.code,
        reviewer.session,
        "submitted-claim",
        [
          {
            taskKey: submitted.review.key,
            expectedVersion: submitted.review.version,
            operation: "claim",
          },
        ],
      );
      const started = await submitted.service.patchWorkItems(
        submitted.project.code,
        reviewer.session,
        "submitted-start",
        [
          {
            taskKey: submitted.review.key,
            expectedVersion: claimed.items[0]!.version,
            operation: "start",
          },
        ],
      );
      const first = await submitted.app.inject({
        method: "POST",
        url: `/api/v1/projects/${submitted.project.code}/reviews/requests/${requestKey}/submit`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: reviewer.session,
          opId: "submitted-first",
          expectedReviewTaskVersion: started.items[0]!.version,
          verdict: "CHANGES_REQUESTED",
          reviewedHashes: [{ name: "git_head", value: "a".repeat(40) }],
          evidence: [{ kind: "test_result", value: "changes required" }],
        },
      });
      expect(first.statusCode).toBe(200);
      const duplicate = await submitted.app.inject({
        method: "POST",
        url: `/api/v1/projects/${submitted.project.code}/reviews/requests/${requestKey}/submit`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: reviewer.session,
          opId: "submitted-again",
          expectedReviewTaskVersion: first.json().reviewTask.version,
          verdict: "CHANGES_REQUESTED",
          reviewedHashes: [{ name: "git_head", value: "a".repeat(40) }],
          evidence: [{ kind: "test_result", value: "changes required" }],
        },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ error: { code: "REVIEW_ALREADY_SUBMITTED" } });
    } finally {
      await submitted.app.close();
      submitted.service.close();
    }

    const closedTask = await openRestReview("RVTCLOSE");
    try {
      const cancelled = await closedTask.service.patchWorkItems(
        closedTask.project.code,
        closedTask.primary,
        "cancel-review",
        [
          {
            taskKey: closedTask.review.key,
            expectedVersion: closedTask.review.version,
            operation: "cancel",
          },
        ],
      );
      const response = await closedTask.app.inject({
        method: "POST",
        url: `/api/v1/projects/${closedTask.project.code}/reviews/requests`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: closedTask.primary,
          opId: "closed-task-request",
          reviewTaskKey: closedTask.review.key,
          expectedReviewTaskVersion: cancelled.items[0]!.version,
          parentChecklistId: closedTask.parent.checklist[0]!.id,
          expectedParentChecklistVersion: closedTask.parent.checklist[0]!.version,
          expectedCandidateHashes: [{ name: "git_head", value: "a".repeat(40) }],
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "REVIEW_TASK_CLOSED" } });
    } finally {
      await closedTask.app.close();
      closedTask.service.close();
    }

    const closedChecklist = await openRestReview("RVCCLOSE");
    try {
      const checked = await closedChecklist.service.updateChecklist(
        closedChecklist.project.code,
        closedChecklist.primary,
        "close-parent-checklist",
        {
          checklistId: closedChecklist.parent.checklist[0]!.id,
          expectedVersion: closedChecklist.parent.checklist[0]!.version,
          status: "DONE",
          evidence: [{ kind: "test_result", value: "already reviewed" }],
        },
      );
      const response = await closedChecklist.app.inject({
        method: "POST",
        url: `/api/v1/projects/${closedChecklist.project.code}/reviews/requests`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: closedChecklist.primary,
          opId: "closed-checklist-request",
          reviewTaskKey: closedChecklist.review.key,
          expectedReviewTaskVersion: closedChecklist.review.version,
          parentChecklistId: closedChecklist.parent.checklist[0]!.id,
          expectedParentChecklistVersion: checked.checklist.version,
          expectedCandidateHashes: [{ name: "git_head", value: "a".repeat(40) }],
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "REVIEW_CHECKLIST_CLOSED" } });
    } finally {
      await closedChecklist.app.close();
      closedChecklist.service.close();
    }

    const binding = await openRestReview("RVBIND");
    try {
      const unrelated = await binding.service.createWorkItems(
        binding.project.code,
        binding.primary,
        "unrelated-parent",
        [
          {
            clientRef: "unrelated",
            objectiveId: binding.parent.objectiveId,
            title: "Unrelated parent",
            type: "TASK",
            priority: "NORMAL",
            status: "IN_PROGRESS",
            checklist: [{ title: "Unrelated gate" }],
          },
        ],
      );
      const unrelatedTask = await binding.service.getWorkItem(
        binding.project.code,
        unrelated.items[0]!.key,
        "full",
      );
      const response = await binding.app.inject({
        method: "POST",
        url: `/api/v1/projects/${binding.project.code}/reviews/requests`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: binding.primary,
          opId: "binding-mismatch-request",
          reviewTaskKey: binding.review.key,
          expectedReviewTaskVersion: binding.review.version,
          parentChecklistId: unrelatedTask.checklist[0]!.id,
          expectedParentChecklistVersion: unrelatedTask.checklist[0]!.version,
          expectedCandidateHashes: [{ name: "git_head", value: "a".repeat(40) }],
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "REVIEW_BINDING_MISMATCH" } });
    } finally {
      await binding.app.close();
      binding.service.close();
    }
  }, 60_000);
});
