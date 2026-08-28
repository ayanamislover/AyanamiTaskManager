import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(code: string): Promise<{
  repository: ProjectRepository;
  actor: { type: "AGENT"; id: string; sessionId: string };
  objectiveId: string;
}> {
  const root = mkdtempSync(join(tmpdir(), `atm-reconciliation-${code.toLowerCase()}-`));
  temporary.push(root);
  const manager = await AyanamiDatabaseManager.open({
    dataDir: join(root, "data"),
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: code, sourcePath: null, code });
  const repository = new ProjectRepository(await manager.openProject(project.code));
  const session = repository.createSession({
    agentId: `${code.toLowerCase()}-author`,
    displayName: `${code} Author`,
    clientKind: "test",
    role: "PRIMARY",
  });
  const actor = {
    type: "AGENT" as const,
    id: `${code.toLowerCase()}-author`,
    sessionId: session.id,
  };
  const objective = repository.createObjective(actor, {
    title: `${code} objective`,
    description: "",
    definitionOfDone: [],
  });
  return { repository, actor, objectiveId: objective.id };
}

function at(value: string): void {
  vi.setSystemTime(new Date(value));
}

describe("incremental reconciliation projections", () => {
  it("records claim/start once, advances restart time, and rolls back failed batches", async () => {
    vi.useFakeTimers();
    const { repository, actor, objectiveId } = await fixture("RPLIFE");
    const created = repository.createWorkItems(actor, "lifecycle-tasks", [
      {
        clientRef: "primary",
        objectiveId,
        title: "Lifecycle task",
        type: "TASK",
        priority: "HIGH",
        status: "READY",
      },
      {
        clientRef: "rollback-first",
        objectiveId,
        title: "Rollback first",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
      },
      {
        clientRef: "rollback-second",
        objectiveId,
        title: "Rollback second",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
      },
    ]);
    const primary = created.items[0]!;

    at("2026-08-27T01:00:00.000Z");
    const claimed = repository.patchWorkItems(actor, "projection-claim", [
      { taskKey: primary.key, expectedVersion: primary.version, operation: "claim" },
    ]).items[0]!;
    expect(claimed).toMatchObject({
      everClaimedAt: "2026-08-27T01:00:00.000Z",
      lastStartedAt: null,
    });

    at("2026-08-27T02:00:00.000Z");
    repository.patchWorkItems(actor, "projection-claim", [
      { taskKey: primary.key, expectedVersion: primary.version, operation: "claim" },
    ]);
    expect(repository.getWorkItem(primary.key)).toMatchObject({
      everClaimedAt: "2026-08-27T01:00:00.000Z",
      lastStartedAt: null,
    });

    at("2026-08-27T03:00:00.000Z");
    const started = repository.patchWorkItems(actor, "projection-start", [
      { taskKey: primary.key, expectedVersion: claimed.version, operation: "start" },
    ]).items[0]!;
    expect(started).toMatchObject({
      everClaimedAt: "2026-08-27T01:00:00.000Z",
      lastStartedAt: "2026-08-27T03:00:00.000Z",
    });

    at("2026-08-27T04:00:00.000Z");
    repository.patchWorkItems(actor, "projection-start", [
      { taskKey: primary.key, expectedVersion: claimed.version, operation: "start" },
    ]);
    expect(repository.getWorkItem(primary.key).lastStartedAt).toBe("2026-08-27T03:00:00.000Z");

    at("2026-08-27T06:00:00.000Z");
    const resumed = repository.patchWorkItems(actor, "projection-successor-reclaim", [
      { taskKey: primary.key, expectedVersion: started.version, operation: "claim" },
    ]).items[0]!;
    expect(resumed).toMatchObject({
      everClaimedAt: "2026-08-27T01:00:00.000Z",
      lastStartedAt: "2026-08-27T06:00:00.000Z",
    });

    at("2026-08-27T05:00:00.000Z");
    repository.patchWorkItems(actor, "projection-clock-regression", [
      { taskKey: primary.key, expectedVersion: resumed.version, operation: "claim" },
    ]);
    expect(repository.getWorkItem(primary.key).lastStartedAt).toBe("2026-08-27T06:00:00.000Z");

    const rollbackFirst = created.items[1]!;
    const rollbackSecond = created.items[2]!;
    at("2026-08-27T07:00:00.000Z");
    expect(() =>
      repository.patchWorkItems(actor, "projection-failed-batch", [
        {
          taskKey: rollbackFirst.key,
          expectedVersion: rollbackFirst.version,
          operation: "claim",
        },
        {
          taskKey: rollbackSecond.key,
          expectedVersion: rollbackSecond.version + 99,
          operation: "claim",
        },
      ]),
    ).toThrow();
    expect(repository.getWorkItem(rollbackFirst.key)).toMatchObject({
      status: "READY",
      everClaimedAt: null,
      lastStartedAt: null,
    });
  });

  it("does not swallow new progress evidence and never advances on evidence-free/noop/replay paths", async () => {
    vi.useFakeTimers();
    const { repository, actor, objectiveId } = await fixture("RPPROG");
    const task = repository.createWorkItems(actor, "progress-task", [
      {
        clientRef: "task",
        objectiveId,
        title: "Progress evidence",
        type: "TASK",
        priority: "HIGH",
        status: "READY",
      },
    ]).items[0]!;
    at("2026-08-27T01:00:00.000Z");
    const claimed = repository.patchWorkItems(actor, "progress-claim", [
      { taskKey: task.key, expectedVersion: task.version, operation: "claim" },
    ]).items[0]!;
    repository.patchWorkItems(actor, "progress-start", [
      { taskKey: task.key, expectedVersion: claimed.version, operation: "start" },
    ]);

    at("2026-08-27T02:00:00.000Z");
    repository.addProgress(actor, "progress-without-evidence", {
      taskKey: task.key,
      percent: 10,
      summary: "same progress",
    });
    expect(repository.getWorkItem(task.key).lastEvidenceAt).toBeNull();

    at("2026-08-27T03:00:00.000Z");
    const evidenced = repository.addProgress(actor, "progress-with-new-evidence", {
      taskKey: task.key,
      percent: 10,
      summary: "same progress",
      evidence: ["progress-proof"],
    });
    expect(evidenced.noop).not.toBe(true);
    expect(repository.getWorkItem(task.key).lastEvidenceAt).toBe("2026-08-27T03:00:00.000Z");

    at("2026-08-27T04:00:00.000Z");
    repository.addProgress(actor, "progress-changed-without-evidence", {
      taskKey: task.key,
      percent: 20,
      summary: "changed without proof",
    });
    expect(repository.getWorkItem(task.key).lastEvidenceAt).toBe("2026-08-27T03:00:00.000Z");

    at("2026-08-27T05:00:00.000Z");
    repository.addProgress(actor, "progress-with-new-evidence", {
      taskKey: task.key,
      percent: 10,
      summary: "same progress",
      evidence: ["progress-proof"],
    });
    expect(repository.getWorkItem(task.key).lastEvidenceAt).toBe("2026-08-27T03:00:00.000Z");

    at("2026-08-27T06:00:00.000Z");
    expect(() =>
      repository.addProgress(actor, "progress-invalid-evidence", {
        taskKey: task.key,
        percent: 30,
        summary: "invalid proof",
        evidence: [{ kind: "atm_task", value: "RPPROG-T-9999" }],
      }),
    ).toThrow();
    expect(repository.getWorkItem(task.key).lastEvidenceAt).toBe("2026-08-27T03:00:00.000Z");
  });

  it("advances checklist and linked project-update evidence only on explicit non-empty proof", async () => {
    vi.useFakeTimers();
    const { repository, actor, objectiveId } = await fixture("RPCHECK");
    const task = repository.createWorkItems(actor, "checklist-task", [
      {
        clientRef: "task",
        objectiveId,
        title: "Checklist evidence",
        type: "TASK",
        priority: "HIGH",
        status: "IN_PROGRESS",
        checklist: [{ title: "First" }, { title: "Second" }],
      },
    ]).items[0]!;
    let current = repository.getWorkItem(task.key);
    const first = current.checklist[0]!;
    const second = current.checklist[1]!;

    at("2026-08-27T02:00:00.000Z");
    let updatedFirst = repository.updateChecklist(actor, "checklist-evidence", {
      checklistId: first.id,
      expectedVersion: first.version,
      status: "DOING",
      evidence: ["check-proof"],
    }).checklist;
    expect(repository.getWorkItem(task.key).lastEvidenceAt).toBe("2026-08-27T02:00:00.000Z");

    at("2026-08-27T03:00:00.000Z");
    updatedFirst = repository.updateChecklist(actor, "checklist-status-only", {
      checklistId: first.id,
      expectedVersion: updatedFirst.version,
      status: "TODO",
    }).checklist;
    expect(repository.getWorkItem(task.key).lastEvidenceAt).toBe("2026-08-27T02:00:00.000Z");

    at("2026-08-27T04:00:00.000Z");
    repository.updateChecklist(actor, "checklist-clear-evidence", {
      checklistId: first.id,
      expectedVersion: updatedFirst.version,
      status: "TODO",
      evidence: [],
    });
    expect(repository.getWorkItem(task.key).lastEvidenceAt).toBe("2026-08-27T02:00:00.000Z");

    current = repository.getWorkItem(task.key);
    at("2026-08-27T05:00:00.000Z");
    repository.updateChecklistBatch(actor, "checklist-batch-evidence", {
      taskKey: task.key,
      expectedVersion: current.version,
      items: [
        { checklistId: first.id, status: "DONE", evidence: ["batch-proof"] },
        { checklistId: second.id, status: "DOING" },
      ],
    });
    expect(repository.getWorkItem(task.key).lastEvidenceAt).toBe("2026-08-27T05:00:00.000Z");

    current = repository.getWorkItem(task.key);
    at("2026-08-27T06:00:00.000Z");
    expect(() =>
      repository.updateChecklistBatch(actor, "checklist-batch-failure", {
        taskKey: task.key,
        expectedVersion: current.version,
        items: [
          { checklistId: second.id, status: "DONE", evidence: ["must-roll-back"] },
          { checklistId: "missing-checklist", status: "DONE" },
        ],
      }),
    ).toThrow();
    expect(repository.getWorkItem(task.key).lastEvidenceAt).toBe("2026-08-27T05:00:00.000Z");

    const beforeProjectEvidence = repository.getWorkItem(task.key);
    at("2026-08-27T07:00:00.000Z");
    repository.publishProjectUpdate(actor, "linked-project-evidence", {
      health: "ON_TRACK",
      summary: "linked proof",
      completed: [{ text: "done", workItemKey: task.key }],
      evidence: ["project-proof"],
    });
    expect(repository.getWorkItem(task.key)).toMatchObject({
      lastEvidenceAt: "2026-08-27T07:00:00.000Z",
      version: beforeProjectEvidence.version,
      updatedAt: beforeProjectEvidence.updatedAt,
    });

    at("2026-08-27T06:30:00.000Z");
    repository.publishProjectUpdate(actor, "older-linked-project-evidence", {
      health: "ON_TRACK",
      summary: "older linked proof",
      completed: [{ text: "done", workItemKey: task.key }],
      evidence: ["older-project-proof"],
    });
    expect(repository.getWorkItem(task.key).lastEvidenceAt).toBe("2026-08-27T07:00:00.000Z");

    at("2026-08-27T08:00:00.000Z");
    repository.publishProjectUpdate(actor, "unlinked-project-evidence", {
      health: "ON_TRACK",
      summary: "unlinked proof",
      completed: ["done"],
      evidence: ["project-proof"],
    });
    at("2026-08-27T09:00:00.000Z");
    repository.publishProjectUpdate(actor, "linked-without-project-evidence", {
      health: "ON_TRACK",
      summary: "linked without proof",
      completed: [{ text: "done", workItemKey: task.key }],
    });
    expect(repository.getWorkItem(task.key).lastEvidenceAt).toBe("2026-08-27T07:00:00.000Z");

    at("2026-08-27T10:00:00.000Z");
    repository.publishProjectUpdate(actor, "linked-project-evidence", {
      health: "ON_TRACK",
      summary: "linked proof",
      completed: [{ text: "done", workItemKey: task.key }],
      evidence: ["project-proof"],
    });
    expect(repository.getWorkItem(task.key).lastEvidenceAt).toBe("2026-08-27T07:00:00.000Z");
  });

  it("attributes submitted review evidence to both review and parent tasks without failed-write drift", async () => {
    vi.useFakeTimers();
    const { repository, actor, objectiveId } = await fixture("RPREVIEW");
    const reviewerSession = repository.createSession({
      agentId: "reviewer",
      displayName: "Reviewer",
      clientKind: "test",
      role: "REVIEWER",
    });
    const reviewer = {
      type: "AGENT" as const,
      id: "reviewer",
      sessionId: reviewerSession.id,
    };
    const created = repository.createWorkItems(actor, "review-evidence-tasks", [
      {
        clientRef: "parent",
        objectiveId,
        title: "Parent task",
        type: "TASK",
        priority: "HIGH",
        status: "IN_PROGRESS",
        checklist: [{ title: "Review", evidenceRequired: true }],
      },
      {
        clientRef: "review",
        objectiveId,
        parentRef: "parent",
        title: "Review task",
        type: "REVIEW",
        priority: "CRITICAL",
        status: "READY",
        assigneeAgentId: "reviewer",
      },
    ]);
    const parent = repository.getWorkItem(created.items[0]!.key);
    const review = created.items[1]!;
    const candidateHashes = [{ name: "git_head", value: "a".repeat(40) }];
    const request = repository.createReviewRequest(actor, "review-evidence-request", {
      reviewTaskKey: review.key,
      expectedReviewTaskVersion: review.version,
      parentChecklistId: parent.checklist[0]!.id,
      expectedParentChecklistVersion: parent.checklist[0]!.version,
      expectedCandidateHashes: candidateHashes,
    });
    const claimed = repository.patchWorkItems(reviewer, "review-evidence-claim", [
      { taskKey: review.key, expectedVersion: review.version, operation: "claim" },
    ]).items[0]!;
    const started = repository.patchWorkItems(reviewer, "review-evidence-start", [
      { taskKey: review.key, expectedVersion: claimed.version, operation: "start" },
    ]).items[0]!;

    const beforeBindingFailure = repository.delta(0, 100).currentSequence;
    let bindingError: unknown;
    try {
      repository.submitReview(reviewer, "review-binding-failed", {
        requestKey: request.request.key,
        reviewTaskKey: parent.key,
        expectedReviewTaskVersion: started.version,
        verdict: "CHANGES_REQUESTED",
        reviewedHashes: candidateHashes,
        evidence: [{ kind: "test_result", value: "must-not-be-written" }],
      });
    } catch (error) {
      bindingError = error;
    }
    expect(bindingError).toMatchObject({
      code: "REVIEW_BINDING_MISMATCH",
      details: {
        request_key: request.request.key,
        task_key: parent.key,
        expected_task_key: review.key,
      },
    });
    expect(repository.delta(0, 100).currentSequence).toBe(beforeBindingFailure);
    expect(repository.getReviewRequest(request.request.key).submission).toBeNull();

    at("2026-08-27T02:00:00.000Z");
    expect(() =>
      repository.submitReview(reviewer, "review-evidence-failed", {
        requestKey: request.request.key,
        expectedReviewTaskVersion: started.version,
        verdict: "CHANGES_REQUESTED",
        reviewedHashes: [{ name: "git_head", value: "b".repeat(40) }],
        evidence: [{ kind: "test_result", value: "rejected-proof" }],
      }),
    ).toThrow();
    expect(repository.getWorkItem(review.key).lastEvidenceAt).toBeNull();
    expect(repository.getWorkItem(parent.key).lastEvidenceAt).toBeNull();

    at("2026-08-27T03:00:00.000Z");
    repository.submitReview(reviewer, "review-evidence-success", {
      requestKey: request.request.key,
      expectedReviewTaskVersion: started.version,
      verdict: "CHANGES_REQUESTED",
      reviewedHashes: candidateHashes,
      evidence: [{ kind: "test_result", value: "review-proof" }],
    });
    expect(repository.getWorkItem(review.key).lastEvidenceAt).toBe("2026-08-27T03:00:00.000Z");
    expect(repository.getWorkItem(parent.key).lastEvidenceAt).toBe("2026-08-27T03:00:00.000Z");
  });
});
