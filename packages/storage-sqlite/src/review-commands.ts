import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import {
  createUlid,
  EvidenceReferenceSchema,
  normalizeReviewCandidateHashes,
  nowIso,
  type WorkItemStatus,
} from "@ayanami-task/protocol";
import { assertCompletionGates } from "./completion-gates.js";
import { EvidenceNormalizer } from "./evidence-normalizer.js";
import { ProjectMutationKernel, type MutationActor } from "./project-mutation-kernel.js";
import { RecordReadModel } from "./record-read-model.js";
import { TaskReadModel } from "./task-read-model.js";
import { WorkItemMaintenance } from "./work-item-maintenance.js";
import { resolveStoredWorkItemOperation } from "./work-item-operation.js";

export type ReviewCandidateHash = { name: string; value: string };

export type ReviewSubmissionView = {
  key: string;
  requestKey: string;
  verdict: "APPROVED" | "CHANGES_REQUESTED";
  reviewedHashes: ReviewCandidateHash[];
  evidence: unknown[];
  recordKey: string;
  reviewerAgentId: string;
  reviewerSessionId: string;
  reviewTaskVersion: number;
  parentChecklistVersion: number;
  createdAt: string;
  opId: string;
};

export type ReviewRequestView = {
  key: string;
  reviewTaskKey: string;
  parentTaskKey: string;
  parentChecklistId: string;
  parentChecklistVersion: number;
  expectedCandidateHashes: ReviewCandidateHash[];
  createdByAgentId: string;
  createdBySessionId: string;
  createdAt: string;
  opId: string;
  submission: ReviewSubmissionView | null;
};

export type CreateReviewRequestInput = {
  reviewTaskKey: string;
  expectedReviewTaskVersion: number;
  parentChecklistId: string;
  expectedParentChecklistVersion: number;
  expectedCandidateHashes: ReviewCandidateHash[];
};

export type SubmitReviewInput = {
  requestKey: string;
  reviewTaskKey?: string;
  expectedReviewTaskVersion: number;
  verdict: "APPROVED" | "CHANGES_REQUESTED";
  reviewedHashes: ReviewCandidateHash[];
  evidence: unknown[];
};

export type SubmitReviewResult = {
  requestKey: string;
  submissionKey: string;
  recordKey: string;
  verdict: "APPROVED" | "CHANGES_REQUESTED";
  reviewTask: { key: string; status: WorkItemStatus; version: number };
  parentChecklist: { id: string; status: string; version: number };
  parentTask: { key: string; status: WorkItemStatus; version: number };
  sequence: number;
};

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class ReviewCommands {
  readonly #sqlite: Database.Database;
  readonly #mutation: ProjectMutationKernel;
  readonly #taskReads: TaskReadModel;
  readonly #recordReads: RecordReadModel;
  readonly #evidence: EvidenceNormalizer;
  readonly #maintenance: WorkItemMaintenance;
  readonly #projectCode: () => string;
  readonly #getSession: (id: string) => any;
  readonly #getReviewRequest: (key: string) => ReviewRequestView;

  constructor(input: {
    sqlite: Database.Database;
    mutation: ProjectMutationKernel;
    taskReads: TaskReadModel;
    recordReads: RecordReadModel;
    evidence: EvidenceNormalizer;
    maintenance: WorkItemMaintenance;
    projectCode: () => string;
    getSession: (id: string) => any;
    getReviewRequest: (key: string) => ReviewRequestView;
  }) {
    this.#sqlite = input.sqlite;
    this.#mutation = input.mutation;
    this.#taskReads = input.taskReads;
    this.#recordReads = input.recordReads;
    this.#evidence = input.evidence;
    this.#maintenance = input.maintenance;
    this.#projectCode = input.projectCode;
    this.#getSession = input.getSession;
    this.#getReviewRequest = input.getReviewRequest;
  }

  reviewRequestRow(requestKey: string): any {
    const prefix = `${this.#projectCode()}-RR-`;
    const suffix = requestKey.startsWith(prefix) ? requestKey.slice(prefix.length) : "";
    if (!/^\d+$/u.test(suffix)) {
      throw new AtmError("REVIEW_REQUEST_NOT_FOUND", {
        message: `Review 请求不存在：${requestKey}`,
        details: { entity: "REVIEW_REQUEST", reference: requestKey },
      });
    }
    const row = this.#sqlite
      .prepare("SELECT * FROM review_requests WHERE local_no = ?")
      .get(Number(suffix));
    if (!row) {
      throw new AtmError("REVIEW_REQUEST_NOT_FOUND", {
        message: `Review 请求不存在：${requestKey}`,
        details: { entity: "REVIEW_REQUEST", reference: requestKey },
      });
    }
    return row;
  }

  reviewRequestKey(localNo: number): string {
    return `${this.#projectCode()}-RR-${String(localNo).padStart(4, "0")}`;
  }

  reviewSubmissionKey(localNo: number): string {
    return `${this.#projectCode()}-RS-${String(localNo).padStart(4, "0")}`;
  }

  getReviewRequest(requestKey: string): ReviewRequestView {
    const request = this.reviewRequestRow(requestKey);
    const reviewTaskKey = this.#taskReads.taskKeyForId(request.review_work_item_id);
    const parentTaskKey = this.#taskReads.taskKeyForId(request.parent_work_item_id);
    if (!reviewTaskKey || !parentTaskKey) {
      throw new AtmError("INTERNAL_ERROR", { message: "Review 绑定数据无效" });
    }
    const submission = this.#sqlite
      .prepare("SELECT * FROM review_submissions WHERE request_id = ?")
      .get(request.id) as any;
    let submissionView: ReviewSubmissionView | null = null;
    if (submission) {
      const record = this.#sqlite
        .prepare("SELECT local_no, kind FROM records WHERE id = ?")
        .get(submission.record_id) as { local_no: number; kind: string } | undefined;
      if (!record) throw new AtmError("INTERNAL_ERROR", { message: "Review 提交记录缺失" });
      submissionView = {
        key: this.reviewSubmissionKey(Number(submission.local_no)),
        requestKey: this.reviewRequestKey(Number(request.local_no)),
        verdict: submission.verdict,
        reviewedHashes: json<ReviewCandidateHash[]>(submission.reviewed_hashes_json, []),
        evidence: json<unknown[]>(submission.evidence_json, []),
        recordKey: this.#recordReads.recordKey(record),
        reviewerAgentId: submission.reviewer_agent_id,
        reviewerSessionId: submission.reviewer_session_id,
        reviewTaskVersion: Number(submission.review_task_version),
        parentChecklistVersion: Number(submission.parent_checklist_version),
        createdAt: String(submission.created_at),
        opId: String(submission.op_id),
      };
    }
    return {
      key: this.reviewRequestKey(Number(request.local_no)),
      reviewTaskKey,
      parentTaskKey,
      parentChecklistId: String(request.parent_checklist_id),
      parentChecklistVersion: Number(request.parent_checklist_version),
      expectedCandidateHashes: json<ReviewCandidateHash[]>(
        request.expected_candidate_hashes_json,
        [],
      ),
      createdByAgentId: String(request.created_by_agent_id),
      createdBySessionId: String(request.created_by_session_id),
      createdAt: String(request.created_at),
      opId: String(request.op_id),
      submission: submissionView,
    };
  }

  createReviewRequest(
    actor: MutationActor,
    opId: string,
    input: CreateReviewRequestInput,
  ): { request: ReviewRequestView; sequence: number } {
    const normalizedInput = {
      ...input,
      expectedCandidateHashes: normalizeReviewCandidateHashes(input.expectedCandidateHashes),
    };
    return this.#mutation.mutate({
      actor,
      opId,
      operation: "review.request.create",
      request: normalizedInput,
      immediate: true,
      action: () => {
        if (!actor.sessionId) {
          throw new AtmError("REVIEW_REQUEST_REQUIRES_SESSION", {
            message: "创建 Review 请求需要活动 Session",
          });
        }
        const reviewTask = this.#taskReads.rowForTaskKey(normalizedInput.reviewTaskKey);
        if (reviewTask.type !== "REVIEW") {
          throw new AtmError("REVIEW_TASK_INVALID", {
            message: `WorkItem 不是 Review 类型：${normalizedInput.reviewTaskKey}`,
            details: { task_key: normalizedInput.reviewTaskKey },
          });
        }
        if (reviewTask.version !== normalizedInput.expectedReviewTaskVersion) {
          throw new AtmError("VERSION_CONFLICT", {
            message: "Review WorkItem 版本已变化",
            details: {
              entity: "WORK_ITEM",
              key: normalizedInput.reviewTaskKey,
              expected: normalizedInput.expectedReviewTaskVersion,
              actual: reviewTask.version,
            },
          });
        }
        if (reviewTask.status === "DONE" || reviewTask.status === "CANCELLED") {
          throw new AtmError("REVIEW_TASK_CLOSED", {
            message: `Review WorkItem 已关闭：${normalizedInput.reviewTaskKey}`,
            details: { task_key: normalizedInput.reviewTaskKey },
          });
        }
        const checklist = this.#sqlite
          .prepare("SELECT * FROM checklist_items WHERE id = ?")
          .get(normalizedInput.parentChecklistId) as any;
        if (!checklist) {
          throw new AtmError("CHECKLIST_NOT_FOUND", {
            message: `检查项不存在：${normalizedInput.parentChecklistId}`,
            details: { entity: "CHECKLIST", reference: normalizedInput.parentChecklistId },
          });
        }
        if (checklist.version !== normalizedInput.expectedParentChecklistVersion) {
          throw new AtmError("VERSION_CONFLICT", {
            message: "检查项版本已变化",
            details: {
              entity: "CHECKLIST",
              key: normalizedInput.parentChecklistId,
              expected: normalizedInput.expectedParentChecklistVersion,
              actual: checklist.version,
            },
          });
        }
        if (!reviewTask.parent_id || reviewTask.parent_id !== checklist.work_item_id) {
          throw new AtmError("REVIEW_BINDING_MISMATCH", {
            message: `Review WorkItem 与父检查项不匹配：${normalizedInput.reviewTaskKey}`,
            details: {
              task_key: normalizedInput.reviewTaskKey,
              checklist_id: normalizedInput.parentChecklistId,
            },
          });
        }
        if (checklist.status === "DONE" || checklist.status === "SKIPPED") {
          throw new AtmError("REVIEW_CHECKLIST_CLOSED", {
            message: `父检查项已关闭：${normalizedInput.parentChecklistId}`,
            details: { checklist_id: normalizedInput.parentChecklistId },
          });
        }
        const existing = this.#sqlite
          .prepare("SELECT id FROM review_requests WHERE review_work_item_id = ?")
          .get(reviewTask.id);
        if (existing) {
          throw new AtmError("REVIEW_REQUEST_CONFLICT", {
            message: `Review WorkItem 已绑定请求：${normalizedInput.reviewTaskKey}`,
            details: { task_key: normalizedInput.reviewTaskKey },
          });
        }
        const id = createUlid();
        const localNo = this.#mutation.nextNumber("review_request");
        const key = this.reviewRequestKey(localNo);
        const now = nowIso();
        this.#sqlite
          .prepare(
            `INSERT INTO review_requests(
               id, local_no, review_work_item_id, parent_work_item_id, parent_checklist_id,
               parent_checklist_version, expected_candidate_hashes_json, created_by_agent_id,
               created_by_session_id, created_at, op_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            localNo,
            reviewTask.id,
            checklist.work_item_id,
            checklist.id,
            checklist.version,
            JSON.stringify(normalizedInput.expectedCandidateHashes),
            actor.id,
            actor.sessionId,
            now,
            opId,
          );
        const sequence = this.#mutation.appendEvent(
          "review.requested",
          actor,
          "REVIEW_REQUEST",
          id,
          {
            key,
            reviewTaskKey: normalizedInput.reviewTaskKey,
            parentTaskKey: this.#taskReads.taskKeyForId(checklist.work_item_id),
            parentChecklistId: checklist.id,
            expectedCandidateHashes: normalizedInput.expectedCandidateHashes,
          },
        );
        return { request: this.#getReviewRequest(key), sequence };
      },
    });
  }

  submitReview(actor: MutationActor, opId: string, input: SubmitReviewInput): SubmitReviewResult {
    const normalizedInput = {
      ...input,
      reviewedHashes: normalizeReviewCandidateHashes(input.reviewedHashes),
      evidence: this.#evidence.normalize(
        input.evidence.map((entry) => EvidenceReferenceSchema.parse(entry)),
      ),
    };
    return this.#mutation.mutate({
      actor,
      opId,
      operation: "review.submit",
      request: normalizedInput,
      immediate: true,
      action: () => {
        if (!actor.sessionId) {
          throw new AtmError("REVIEWER_SESSION_REQUIRED", {
            message: "提交 Review 需要活动 Session",
          });
        }
        const session = this.#getSession(actor.sessionId);
        if (
          session.role !== "REVIEWER" ||
          session.agent_id !== actor.id ||
          session.connection_state !== "ONLINE"
        ) {
          throw new AtmError("REVIEWER_REQUIRED", {
            message: `当前 Session 不具备 Reviewer 身份：${actor.sessionId}`,
            details: { session_id: actor.sessionId },
          });
        }
        const request = this.reviewRequestRow(normalizedInput.requestKey);
        const existing = this.#sqlite
          .prepare("SELECT id FROM review_submissions WHERE request_id = ?")
          .get(request.id);
        if (existing) {
          throw new AtmError("REVIEW_ALREADY_SUBMITTED", {
            message: `Review 请求已提交：${normalizedInput.requestKey}`,
            details: { request_key: normalizedInput.requestKey },
          });
        }
        const reviewTask = this.#sqlite
          .prepare("SELECT * FROM work_items WHERE id = ?")
          .get(request.review_work_item_id) as any;
        if (!reviewTask || reviewTask.type !== "REVIEW") {
          throw new AtmError("INTERNAL_ERROR", { message: "Review 请求指向无效 WorkItem" });
        }
        const reviewTaskKey = this.#taskReads.taskKeyForId(reviewTask.id);
        if (!reviewTaskKey) {
          throw new AtmError("INTERNAL_ERROR", { message: "Review WorkItem key 缺失" });
        }
        if (
          normalizedInput.reviewTaskKey !== undefined &&
          normalizedInput.reviewTaskKey !== reviewTaskKey
        ) {
          throw new AtmError("REVIEW_BINDING_MISMATCH", {
            message: `Review 请求与 WorkItem 不匹配：${normalizedInput.reviewTaskKey}`,
            details: {
              request_key: normalizedInput.requestKey,
              task_key: normalizedInput.reviewTaskKey,
              expected_task_key: reviewTaskKey,
            },
          });
        }
        if (reviewTask.version !== normalizedInput.expectedReviewTaskVersion) {
          throw new AtmError("VERSION_CONFLICT", {
            message: "Review WorkItem 版本已变化",
            details: {
              entity: "WORK_ITEM",
              key: reviewTaskKey,
              expected: normalizedInput.expectedReviewTaskVersion,
              actual: reviewTask.version,
            },
          });
        }
        if (
          reviewTask.assignee_agent_id !== actor.id ||
          reviewTask.claimed_by_session_id !== actor.sessionId
        ) {
          throw new AtmError("REVIEW_IDENTITY_MISMATCH", {
            message: `Reviewer 身份与 Review WorkItem 领取者不匹配：${reviewTaskKey}`,
            details: { task_key: reviewTaskKey, session_id: actor.sessionId },
          });
        }
        const expectedHashes = json<ReviewCandidateHash[]>(
          request.expected_candidate_hashes_json,
          [],
        );
        if (JSON.stringify(expectedHashes) !== JSON.stringify(normalizedInput.reviewedHashes)) {
          throw new AtmError("CANDIDATE_HASH_MISMATCH", {
            message: `Review 候选哈希不匹配：${normalizedInput.requestKey}`,
            details: {
              request_key: normalizedInput.requestKey,
              expected: expectedHashes,
              actual: normalizedInput.reviewedHashes,
            },
          });
        }
        const parentChecklist = this.#sqlite
          .prepare("SELECT * FROM checklist_items WHERE id = ?")
          .get(request.parent_checklist_id) as any;
        if (
          !parentChecklist ||
          parentChecklist.work_item_id !== request.parent_work_item_id ||
          reviewTask.parent_id !== request.parent_work_item_id
        ) {
          throw new AtmError("INTERNAL_ERROR", { message: "已存储的 Review 绑定无效" });
        }
        if (parentChecklist.version !== request.parent_checklist_version) {
          throw new AtmError("VERSION_CONFLICT", {
            message: "父检查项版本已变化",
            details: {
              entity: "CHECKLIST",
              key: request.parent_checklist_id,
              expected: request.parent_checklist_version,
              actual: parentChecklist.version,
            },
          });
        }
        resolveStoredWorkItemOperation("complete", reviewTask);
        assertCompletionGates(this.#sqlite, reviewTask);

        const now = nowIso();
        const requestKey = this.reviewRequestKey(Number(request.local_no));
        const submissionId = createUlid();
        const submissionLocalNo = this.#mutation.nextNumber("review_submission");
        const submissionKey = this.reviewSubmissionKey(submissionLocalNo);
        const recordId = createUlid();
        const recordLocalNo = this.#mutation.nextNumber("record");
        const recordKey = this.#recordReads.recordKey({
          local_no: recordLocalNo,
          kind: "VERIFICATION",
        });
        const summary = `${normalizedInput.verdict} review for ${reviewTaskKey}`;
        const detail = JSON.stringify(
          {
            requestKey,
            submissionKey,
            verdict: normalizedInput.verdict,
            expectedCandidateHashes: expectedHashes,
            reviewedHashes: normalizedInput.reviewedHashes,
            evidence: normalizedInput.evidence,
            reviewerAgentId: actor.id,
            reviewerSessionId: actor.sessionId,
          },
          null,
          2,
        );
        this.#sqlite
          .prepare(
            `INSERT INTO records(
               id, local_no, kind, title, summary, detail, importance, status,
               supersedes_id, scope, work_item_id, actor, version, created_at, updated_at,
               source_type, source_actor_id, source_session_id, source_ref, topic, subject_key,
               op_id
             ) VALUES (?, ?, 'VERIFICATION', ?, ?, ?, 'HIGH', 'ACTIVE', NULL,
               'REVIEW_AUDIT', ?, ?, 0, ?, ?, 'AGENT', ?, ?, ?, 'review-verdict', ?, ?)`,
          )
          .run(
            recordId,
            recordLocalNo,
            `Review ${normalizedInput.verdict}: ${reviewTaskKey}`,
            summary,
            detail,
            reviewTask.id,
            actor.id,
            now,
            now,
            actor.id,
            actor.sessionId,
            submissionKey,
            reviewTaskKey,
            opId,
          );
        this.#mutation.appendEvent("record.created", actor, "RECORD", recordId, {
          key: recordKey,
          kind: "VERIFICATION",
          title: `Review ${normalizedInput.verdict}: ${reviewTaskKey}`,
          summary,
          topic: "review-verdict",
          subjectKey: reviewTaskKey,
        });
        this.#maintenance.upsertSearchDocument(
          "RECORD",
          recordId,
          recordKey,
          `Review ${normalizedInput.verdict}: ${reviewTaskKey}`,
          `${summary}\n${detail}`,
        );

        if (normalizedInput.verdict === "APPROVED") {
          this.#sqlite
            .prepare(
              `UPDATE checklist_items SET status = 'DONE', evidence_json = ?,
               version = version + 1, updated_at = ? WHERE id = ?`,
            )
            .run(JSON.stringify(normalizedInput.evidence), now, parentChecklist.id);
          this.#maintenance.recomputeWorkItem(parentChecklist.work_item_id);
          this.#mutation.appendEvent("checklist.updated", actor, "CHECKLIST", parentChecklist.id, {
            workItemId: parentChecklist.work_item_id,
            taskKey: this.#taskReads.taskKeyForId(parentChecklist.work_item_id),
            status: "DONE",
            reviewRequestKey: requestKey,
            reviewSubmissionKey: submissionKey,
          });
        }

        this.#sqlite
          .prepare(
            `UPDATE work_items SET status = 'DONE', phase = 'DONE', phase_inferred = 0,
             waiting_on = NULL, waiting_for = NULL, completed_at = ?, computed_progress = 100,
             reported_progress = 100, version = version + 1, updated_at = ? WHERE id = ?`,
          )
          .run(now, now, reviewTask.id);
        this.#sqlite
          .prepare(
            `UPDATE agent_sessions SET current_work_item_id = NULL, work_state = 'IDLE',
             heartbeat_at = ?, updated_at = ?, version = version + 1
             WHERE id = ? AND current_work_item_id = ?`,
          )
          .run(now, now, actor.sessionId, reviewTask.id);
        this.#mutation.appendEvent("work.completed", actor, "WORK_ITEM", reviewTask.id, {
          key: reviewTaskKey,
          title: reviewTask.title,
          operation: "review_submit",
          status: "DONE",
          phase: "DONE",
          reviewRequestKey: requestKey,
          verdict: normalizedInput.verdict,
        });
        this.#maintenance.recomputeWorkItem(request.parent_work_item_id);

        const finalReviewTask = this.#sqlite
          .prepare("SELECT * FROM work_items WHERE id = ?")
          .get(reviewTask.id) as any;
        const finalChecklist = this.#sqlite
          .prepare("SELECT * FROM checklist_items WHERE id = ?")
          .get(parentChecklist.id) as any;
        const finalParent = this.#sqlite
          .prepare("SELECT * FROM work_items WHERE id = ?")
          .get(request.parent_work_item_id) as any;
        const parentTaskKey = this.#taskReads.taskKeyForId(finalParent.id);
        if (!parentTaskKey) {
          throw new AtmError("INTERNAL_ERROR", { message: "父 WorkItem key 缺失" });
        }
        this.#sqlite
          .prepare(
            `INSERT INTO review_submissions(
               id, local_no, request_id, verdict, reviewed_hashes_json, evidence_json,
               record_id, reviewer_agent_id, reviewer_session_id, review_task_version,
               parent_checklist_version, created_at, op_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            submissionId,
            submissionLocalNo,
            request.id,
            normalizedInput.verdict,
            JSON.stringify(normalizedInput.reviewedHashes),
            JSON.stringify(normalizedInput.evidence),
            recordId,
            actor.id,
            actor.sessionId,
            finalReviewTask.version,
            finalChecklist.version,
            now,
            opId,
          );
        if (normalizedInput.evidence.length > 0) {
          this.#maintenance.advanceWorkItemEvidenceAt(reviewTask.id, now);
          this.#maintenance.advanceWorkItemEvidenceAt(request.parent_work_item_id, now);
        }
        const sequence = this.#mutation.appendEvent(
          "review.submitted",
          actor,
          "REVIEW_SUBMISSION",
          submissionId,
          {
            key: submissionKey,
            requestKey,
            reviewTaskKey,
            parentTaskKey,
            parentChecklistId: finalChecklist.id,
            recordKey,
            verdict: normalizedInput.verdict,
            reviewedHashes: normalizedInput.reviewedHashes,
          },
        );
        return {
          requestKey,
          submissionKey,
          recordKey,
          verdict: normalizedInput.verdict,
          reviewTask: {
            key: reviewTaskKey,
            status: finalReviewTask.status,
            version: finalReviewTask.version,
          },
          parentChecklist: {
            id: finalChecklist.id,
            status: finalChecklist.status,
            version: finalChecklist.version,
          },
          parentTask: {
            key: parentTaskKey,
            status: finalParent.status,
            version: finalParent.version,
          },
          sequence,
        };
      },
    });
  }
}
