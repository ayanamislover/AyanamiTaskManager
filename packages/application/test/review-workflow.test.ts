import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function openReviewFixture(code: string, reviewChecklist = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-review-workflow-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await service.createProject({ name: "一等 Review", sourcePath: null, code });
  const primary = await service.begin({
    projectCode: project.code,
    agentId: "author-agent",
    role: "PRIMARY",
  });
  const objective = await service.createObjective(project.code, primary.session, {
    title: "Review verdict",
    description: "",
    definitionOfDone: [],
  });
  const created = await service.createWorkItems(project.code, primary.session, "create-review", [
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
  return { service, project, primary: primary.session, parent, review };
}

describe("一等 Review verdict 工作流", () => {
  it("创建并读回绑定 REVIEW WorkItem、父 checklist 和规范化候选 hashes 的请求", async () => {
    const ctx = await openReviewFixture("RVREQ");
    try {
      const created = await ctx.service.createReviewRequest(
        ctx.project.code,
        ctx.primary,
        "request-create",
        {
          reviewTaskKey: ctx.review.key,
          expectedReviewTaskVersion: ctx.review.version,
          parentChecklistId: ctx.parent.checklist[0]!.id,
          expectedParentChecklistVersion: ctx.parent.checklist[0]!.version,
          expectedCandidateHashes: [
            { name: "WorkTree", value: "B".repeat(64) },
            { name: "git_head", value: "A".repeat(40) },
          ],
        },
      );

      expect(created).toMatchObject({ opId: "request-create" });
      expect(created.request).toMatchObject({
        key: "RVREQ-RR-0001",
        reviewTaskKey: ctx.review.key,
        parentTaskKey: ctx.parent.key,
        parentChecklistId: ctx.parent.checklist[0]!.id,
        expectedCandidateHashes: [
          { name: "git_head", value: "a".repeat(40) },
          { name: "worktree", value: "b".repeat(64) },
        ],
        submission: null,
      });
      expect(await ctx.service.getReviewRequest(ctx.project.code, created.request.key)).toEqual(
        created.request,
      );
      await expect(
        ctx.service.getReviewRequest(ctx.project.code, "OTHER-RR-0001"),
      ).rejects.toMatchObject({
        code: "REVIEW_REQUEST_NOT_FOUND",
        details: { entity: "REVIEW_REQUEST", reference: "OTHER-RR-0001" },
      });
      const replayed = await ctx.service.createReviewRequest(
        ctx.project.code,
        ctx.primary,
        "request-create",
        {
          reviewTaskKey: ctx.review.key,
          expectedReviewTaskVersion: ctx.review.version,
          parentChecklistId: ctx.parent.checklist[0]!.id,
          expectedParentChecklistVersion: ctx.parent.checklist[0]!.version,
          expectedCandidateHashes: [
            { name: "GIT_HEAD", value: "A".repeat(40) },
            { name: "worktree", value: "B".repeat(64) },
          ],
        },
      );
      expect(replayed).toEqual(created);
      await expect(
        ctx.service.createReviewRequest(ctx.project.code, ctx.primary, "request-create", {
          reviewTaskKey: ctx.review.key,
          expectedReviewTaskVersion: ctx.review.version,
          parentChecklistId: ctx.parent.checklist[0]!.id,
          expectedParentChecklistVersion: ctx.parent.checklist[0]!.version,
          expectedCandidateHashes: [{ name: "git_head", value: "f".repeat(40) }],
        }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        details: { session_id: ctx.primary, operation_id: "request-create" },
      });
    } finally {
      ctx.service.close();
    }
  });

  it("APPROVED 原子生成审计 Record、完成 Review Task 与父 checklist，但不完成父任务", async () => {
    const ctx = await openReviewFixture("RVAPP");
    try {
      const expectedHashes = [
        { name: "git_head", value: "a".repeat(40) },
        { name: "worktree", value: "b".repeat(64) },
      ];
      const request = await ctx.service.createReviewRequest(
        ctx.project.code,
        ctx.primary,
        "approved-request",
        {
          reviewTaskKey: ctx.review.key,
          expectedReviewTaskVersion: ctx.review.version,
          parentChecklistId: ctx.parent.checklist[0]!.id,
          expectedParentChecklistVersion: ctx.parent.checklist[0]!.version,
          expectedCandidateHashes: expectedHashes,
        },
      );
      const reviewer = await ctx.service.begin({
        projectCode: ctx.project.code,
        agentId: "review-agent",
        role: "REVIEWER",
      });
      const claimed = await ctx.service.patchWorkItems(
        ctx.project.code,
        reviewer.session,
        "review-claim",
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
        "review-start",
        [
          {
            taskKey: ctx.review.key,
            expectedVersion: claimed.items[0]!.version,
            operation: "start",
          },
        ],
      );

      const result = await ctx.service.submitReview(
        ctx.project.code,
        reviewer.session,
        "review-approved",
        {
          requestKey: request.request.key,
          expectedReviewTaskVersion: started.items[0]!.version,
          verdict: "APPROVED",
          reviewedHashes: [...expectedHashes].reverse(),
          evidence: [{ kind: "test_result", value: "review-gate: 42 tests passed" }],
        },
      );

      expect(result).toMatchObject({
        opId: "review-approved",
        requestKey: "RVAPP-RR-0001",
        submissionKey: "RVAPP-RS-0001",
        recordKey: "RVAPP-R-001",
        verdict: "APPROVED",
        reviewTask: { key: ctx.review.key, status: "DONE" },
        parentChecklist: { id: ctx.parent.checklist[0]!.id, status: "DONE" },
        parentTask: { key: ctx.parent.key, status: "IN_PROGRESS" },
      });
      expect(
        (await ctx.service.getReviewRequest(ctx.project.code, request.request.key)).submission,
      ).toMatchObject({
        key: "RVAPP-RS-0001",
        verdict: "APPROVED",
        recordKey: "RVAPP-R-001",
      });
      expect(await ctx.service.getRecord(ctx.project.code, result.recordKey)).toMatchObject({
        kind: "VERIFICATION",
        scope: "REVIEW_AUDIT",
        status: "ACTIVE",
        workItemKey: ctx.review.key,
      });
      await expect(
        ctx.service.createRecord(ctx.project.code, ctx.primary, "supersede-review-audit", {
          kind: "VERIFICATION",
          title: "不允许覆盖 Review 审计",
          summary: "Review verdict 必须保持不可变",
          supersedes: result.recordKey,
        }),
      ).rejects.toMatchObject({
        code: "IMMUTABLE_RECORD",
        details: { record_key: result.recordKey },
      });
      expect(await ctx.service.getRecord(ctx.project.code, result.recordKey)).toMatchObject({
        status: "ACTIVE",
      });
      expect((await ctx.service.getWorkItem(ctx.project.code, ctx.parent.key, "full")).status).toBe(
        "IN_PROGRESS",
      );
      expect(
        (await ctx.service.getWorkItem(ctx.project.code, ctx.parent.key, "full")).checklist[0],
      ).toMatchObject({
        status: "DONE",
        evidence: [{ kind: "test_result", value: "review-gate: 42 tests passed" }],
      });
    } finally {
      ctx.service.close();
    }
  });

  it("CHANGES_REQUESTED 完成 Review 审计但保留父门禁，并让提交 opId 精确幂等", async () => {
    const ctx = await openReviewFixture("RVCHG");
    try {
      const expectedHashes = [{ name: "git_head", value: "c".repeat(40) }];
      const request = await ctx.service.createReviewRequest(
        ctx.project.code,
        ctx.primary,
        "changes-request",
        {
          reviewTaskKey: ctx.review.key,
          expectedReviewTaskVersion: ctx.review.version,
          parentChecklistId: ctx.parent.checklist[0]!.id,
          expectedParentChecklistVersion: ctx.parent.checklist[0]!.version,
          expectedCandidateHashes: expectedHashes,
        },
      );
      const reviewer = await ctx.service.begin({
        projectCode: ctx.project.code,
        agentId: "review-agent",
        role: "REVIEWER",
      });
      const claimed = await ctx.service.patchWorkItems(
        ctx.project.code,
        reviewer.session,
        "changes-claim",
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
        "changes-start",
        [
          {
            taskKey: ctx.review.key,
            expectedVersion: claimed.items[0]!.version,
            operation: "start",
          },
        ],
      );
      const submission = {
        requestKey: request.request.key,
        expectedReviewTaskVersion: started.items[0]!.version,
        verdict: "CHANGES_REQUESTED" as const,
        reviewedHashes: expectedHashes,
        evidence: [{ kind: "test_result", value: "review found blocking issue" }],
      };
      const first = await ctx.service.submitReview(
        ctx.project.code,
        reviewer.session,
        "review-changes",
        submission,
      );

      expect(first).toMatchObject({
        verdict: "CHANGES_REQUESTED",
        reviewTask: { status: "DONE" },
        parentChecklist: { status: "TODO", version: 0 },
        parentTask: { status: "IN_PROGRESS" },
      });
      expect(
        await ctx.service.submitReview(
          ctx.project.code,
          reviewer.session,
          "review-changes",
          submission,
        ),
      ).toEqual(first);
      expect(await ctx.service.listRecords(ctx.project.code)).toHaveLength(1);
      await expect(
        ctx.service.submitReview(ctx.project.code, reviewer.session, "review-changes", {
          ...submission,
          verdict: "APPROVED",
        }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        details: { session_id: reviewer.session, operation_id: "review-changes" },
      });
      await expect(
        ctx.service.submitReview(ctx.project.code, reviewer.session, "review-changes-again", {
          ...submission,
          expectedReviewTaskVersion: first.reviewTask.version,
        }),
      ).rejects.toMatchObject({
        code: "REVIEW_ALREADY_SUBMITTED",
        details: { request_key: submission.requestKey },
      });
      expect(await ctx.service.listRecords(ctx.project.code)).toHaveLength(1);
    } finally {
      ctx.service.close();
    }
  });

  it("候选 hash、REVIEWER 身份或完成门禁失败时不留下 submission、Record、状态或事件", async () => {
    const expectedHashes = [{ name: "git_head", value: "d".repeat(40) }];
    const assertPublicState = async (
      ctx: Awaited<ReturnType<typeof openReviewFixture>>,
      requestKey: string,
      expected: {
        review: { status: string; version: number };
        parent: { status: string; version: number; checklistVersion: number };
        sequence: number;
      },
    ) => {
      const review = await ctx.service.getWorkItem(ctx.project.code, ctx.review.key, "full");
      const parent = await ctx.service.getWorkItem(ctx.project.code, ctx.parent.key, "full");
      expect({ status: review.status, version: review.version }).toEqual(expected.review);
      expect({
        status: parent.status,
        version: parent.version,
        checklistVersion: parent.checklist[0]!.version,
      }).toEqual(expected.parent);
      expect(await ctx.service.listRecords(ctx.project.code)).toHaveLength(0);
      expect(
        (await ctx.service.getReviewRequest(ctx.project.code, requestKey)).submission,
      ).toBeNull();
      expect((await ctx.service.delta(ctx.project.code, 0, 100)).currentSequence).toBe(
        expected.sequence,
      );
    };

    const hashCtx = await openReviewFixture("RVHASH");
    try {
      const request = await hashCtx.service.createReviewRequest(
        hashCtx.project.code,
        hashCtx.primary,
        "hash-request",
        {
          reviewTaskKey: hashCtx.review.key,
          expectedReviewTaskVersion: hashCtx.review.version,
          parentChecklistId: hashCtx.parent.checklist[0]!.id,
          expectedParentChecklistVersion: hashCtx.parent.checklist[0]!.version,
          expectedCandidateHashes: expectedHashes,
        },
      );
      const reviewer = await hashCtx.service.begin({
        projectCode: hashCtx.project.code,
        agentId: "review-agent",
        role: "REVIEWER",
      });
      const claimed = await hashCtx.service.patchWorkItems(
        hashCtx.project.code,
        reviewer.session,
        "hash-claim",
        [
          {
            taskKey: hashCtx.review.key,
            expectedVersion: hashCtx.review.version,
            operation: "claim",
          },
        ],
      );
      const started = await hashCtx.service.patchWorkItems(
        hashCtx.project.code,
        reviewer.session,
        "hash-start",
        [
          {
            taskKey: hashCtx.review.key,
            expectedVersion: claimed.items[0]!.version,
            operation: "start",
          },
        ],
      );
      const beforeReview = await hashCtx.service.getWorkItem(
        hashCtx.project.code,
        hashCtx.review.key,
      );
      const beforeParent = await hashCtx.service.getWorkItem(
        hashCtx.project.code,
        hashCtx.parent.key,
        "full",
      );
      const beforeSequence = (await hashCtx.service.delta(hashCtx.project.code, 0, 100))
        .currentSequence;
      await expect(
        hashCtx.service.submitReview(hashCtx.project.code, reviewer.session, "hash-mismatch", {
          requestKey: request.request.key,
          expectedReviewTaskVersion: started.items[0]!.version,
          verdict: "APPROVED",
          reviewedHashes: [{ name: "git_head", value: "e".repeat(40) }],
          evidence: [{ kind: "test_result", value: "tests passed" }],
        }),
      ).rejects.toMatchObject({
        code: "CANDIDATE_HASH_MISMATCH",
        details: {
          request_key: request.request.key,
          expected: expectedHashes,
          actual: [{ name: "git_head", value: "e".repeat(40) }],
        },
      });
      await expect(
        hashCtx.service.submitReview(hashCtx.project.code, reviewer.session, "plain-evidence", {
          requestKey: request.request.key,
          expectedReviewTaskVersion: started.items[0]!.version,
          verdict: "APPROVED",
          reviewedHashes: expectedHashes,
          evidence: ["plain text is not structured"],
        }),
      ).rejects.toThrow();
      await assertPublicState(hashCtx, request.request.key, {
        review: { status: beforeReview.status, version: beforeReview.version },
        parent: {
          status: beforeParent.status,
          version: beforeParent.version,
          checklistVersion: beforeParent.checklist[0]!.version,
        },
        sequence: beforeSequence,
      });
    } finally {
      hashCtx.service.close();
    }

    const identityCtx = await openReviewFixture("RVID");
    try {
      const request = await identityCtx.service.createReviewRequest(
        identityCtx.project.code,
        identityCtx.primary,
        "identity-request",
        {
          reviewTaskKey: identityCtx.review.key,
          expectedReviewTaskVersion: identityCtx.review.version,
          parentChecklistId: identityCtx.parent.checklist[0]!.id,
          expectedParentChecklistVersion: identityCtx.parent.checklist[0]!.version,
          expectedCandidateHashes: expectedHashes,
        },
      );
      const intruder = await identityCtx.service.begin({
        projectCode: identityCtx.project.code,
        agentId: "other-reviewer",
        role: "REVIEWER",
      });
      const beforeSequence = (await identityCtx.service.delta(identityCtx.project.code, 0, 100))
        .currentSequence;
      await expect(
        identityCtx.service.submitReview(
          identityCtx.project.code,
          intruder.session,
          "identity-mismatch",
          {
            requestKey: request.request.key,
            expectedReviewTaskVersion: identityCtx.review.version,
            verdict: "APPROVED",
            reviewedHashes: expectedHashes,
            evidence: [{ kind: "test_result", value: "tests passed" }],
          },
        ),
      ).rejects.toMatchObject({
        code: "REVIEW_IDENTITY_MISMATCH",
        details: { task_key: identityCtx.review.key, session_id: intruder.session },
      });
      await assertPublicState(identityCtx, request.request.key, {
        review: { status: identityCtx.review.status, version: identityCtx.review.version },
        parent: {
          status: identityCtx.parent.status,
          version: identityCtx.parent.version,
          checklistVersion: identityCtx.parent.checklist[0]!.version,
        },
        sequence: beforeSequence,
      });
    } finally {
      identityCtx.service.close();
    }

    const gateCtx = await openReviewFixture("RVGATE", true);
    try {
      const request = await gateCtx.service.createReviewRequest(
        gateCtx.project.code,
        gateCtx.primary,
        "gate-request",
        {
          reviewTaskKey: gateCtx.review.key,
          expectedReviewTaskVersion: gateCtx.review.version,
          parentChecklistId: gateCtx.parent.checklist[0]!.id,
          expectedParentChecklistVersion: gateCtx.parent.checklist[0]!.version,
          expectedCandidateHashes: expectedHashes,
        },
      );
      const reviewer = await gateCtx.service.begin({
        projectCode: gateCtx.project.code,
        agentId: "review-agent",
        role: "REVIEWER",
      });
      const claimed = await gateCtx.service.patchWorkItems(
        gateCtx.project.code,
        reviewer.session,
        "gate-claim",
        [
          {
            taskKey: gateCtx.review.key,
            expectedVersion: gateCtx.review.version,
            operation: "claim",
          },
        ],
      );
      const started = await gateCtx.service.patchWorkItems(
        gateCtx.project.code,
        reviewer.session,
        "gate-start",
        [
          {
            taskKey: gateCtx.review.key,
            expectedVersion: claimed.items[0]!.version,
            operation: "start",
          },
        ],
      );
      const beforeReview = await gateCtx.service.getWorkItem(
        gateCtx.project.code,
        gateCtx.review.key,
      );
      const beforeParent = await gateCtx.service.getWorkItem(
        gateCtx.project.code,
        gateCtx.parent.key,
        "full",
      );
      const beforeSequence = (await gateCtx.service.delta(gateCtx.project.code, 0, 100))
        .currentSequence;
      await expect(
        gateCtx.service.submitReview(gateCtx.project.code, reviewer.session, "gate-failure", {
          requestKey: request.request.key,
          expectedReviewTaskVersion: started.items[0]!.version,
          verdict: "APPROVED",
          reviewedHashes: expectedHashes,
          evidence: [{ kind: "test_result", value: "tests passed" }],
        }),
      ).rejects.toMatchObject({
        code: "COMPLETION_GATE_FAILED",
        details: {
          reasons: expect.arrayContaining([
            {
              checklist_id: gateCtx.review.checklist[0]!.id,
              code: "CHECKLIST_INCOMPLETE",
            },
          ]),
        },
      });
      await assertPublicState(gateCtx, request.request.key, {
        review: { status: beforeReview.status, version: beforeReview.version },
        parent: {
          status: beforeParent.status,
          version: beforeParent.version,
          checklistVersion: beforeParent.checklist[0]!.version,
        },
        sequence: beforeSequence,
      });
    } finally {
      gateCtx.service.close();
    }
  });
});
