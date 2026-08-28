import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function fixture(code: string) {
  const root = mkdtempSync(join(tmpdir(), `atm-review-record-${code.toLowerCase()}-`));
  temporary.push(root);
  const manager = await AyanamiDatabaseManager.open({
    dataDir: join(root, "data"),
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: code, sourcePath: null, code });
  const database = await manager.openProject(project.code);
  const repository = new ProjectRepository(database);
  const session = repository.createSession({
    agentId: `${code.toLowerCase()}-primary`,
    displayName: `${code} Primary`,
    clientKind: "test",
    role: "SUBAGENT",
  });
  const actor = {
    type: "AGENT" as const,
    id: `${code.toLowerCase()}-primary`,
    sessionId: session.id,
  };
  return { database, repository, actor };
}

type DatabaseFixture = Awaited<ReturnType<AyanamiDatabaseManager["openProject"]>>;

function scalar(database: DatabaseFixture, sql: string): number {
  return Number((database.sqlite.prepare(sql).get() as { value: number }).value);
}

function mutationCounts(database: DatabaseFixture) {
  return {
    sequence: scalar(
      database,
      "SELECT current_sequence AS value FROM project_meta WHERE singleton = 1",
    ),
    events: scalar(database, "SELECT COUNT(*) AS value FROM events"),
    outbox: scalar(database, "SELECT COUNT(*) AS value FROM outbox"),
    idempotency: scalar(database, "SELECT COUNT(*) AS value FROM idempotency_keys"),
  };
}

async function reviewFixture(code: string) {
  const base = await fixture(code);
  const objective = base.repository.createObjective(base.actor, {
    title: "Review objective",
    description: "",
    definitionOfDone: [],
  });
  const created = base.repository.createWorkItems(base.actor, `${code}-create`, [
    {
      clientRef: "parent",
      objectiveId: objective.id,
      title: "Parent task",
      type: "TASK",
      priority: "NORMAL",
      status: "IN_PROGRESS",
      checklist: [{ title: "Independent review", evidenceRequired: true }],
    },
    {
      clientRef: "review",
      objectiveId: objective.id,
      parentRef: "parent",
      title: "Review task",
      type: "REVIEW",
      priority: "HIGH",
      status: "READY",
      assigneeAgentId: `${code.toLowerCase()}-reviewer`,
    },
  ]).items;
  return {
    ...base,
    parent: base.repository.getWorkItem(created[0]!.key),
    review: created[1]!,
    hashes: [{ name: "git_head", value: "a".repeat(40) }],
  };
}

async function readySubmission(code: string) {
  const base = await reviewFixture(code);
  const request = base.repository.createReviewRequest(base.actor, `${code}-request`, {
    reviewTaskKey: base.review.key,
    expectedReviewTaskVersion: base.review.version,
    parentChecklistId: base.parent.checklist[0]!.id,
    expectedParentChecklistVersion: base.parent.checklist[0]!.version,
    expectedCandidateHashes: base.hashes,
  });
  const reviewerSession = base.repository.createSession({
    agentId: `${code.toLowerCase()}-reviewer`,
    displayName: `${code} Reviewer`,
    clientKind: "test",
    role: "REVIEWER",
  });
  const reviewer = {
    type: "AGENT" as const,
    id: `${code.toLowerCase()}-reviewer`,
    sessionId: reviewerSession.id,
  };
  const claimed = base.repository.patchWorkItems(reviewer, `${code}-claim`, [
    { taskKey: base.review.key, expectedVersion: base.review.version, operation: "claim" },
  ]).items[0]!;
  const started = base.repository.patchWorkItems(reviewer, `${code}-start`, [
    { taskKey: base.review.key, expectedVersion: claimed.version, operation: "start" },
  ]).items[0]!;
  return { ...base, request, reviewer, reviewerSession, started };
}

describe("Review and Record command transaction boundaries", () => {
  it("rolls back review request, counter, event, outbox and idempotency when request append fails", async () => {
    const { database, repository, actor, parent, review, hashes } = await reviewFixture("RREQF");
    const state = () => ({
      ...mutationCounts(database),
      requests: scalar(database, "SELECT COUNT(*) AS value FROM review_requests"),
      counter: database.sqlite
        .prepare("SELECT next_value FROM counters WHERE name = 'review_request'")
        .get(),
    });
    const before = state();
    database.sqlite.exec(`
      CREATE TRIGGER fail_review_request_outbox
      BEFORE INSERT ON outbox
      WHEN NEW.payload_json LIKE '%review.requested%'
      BEGIN
        SELECT RAISE(ABORT, 'injected review request outbox failure');
      END;
    `);
    const input = {
      reviewTaskKey: review.key,
      expectedReviewTaskVersion: review.version,
      parentChecklistId: parent.checklist[0]!.id,
      expectedParentChecklistVersion: parent.checklist[0]!.version,
      expectedCandidateHashes: hashes,
    };

    expect(() => repository.createReviewRequest(actor, "request-failure", input)).toThrow(
      "injected review request outbox failure",
    );
    expect(state()).toEqual(before);

    database.sqlite.exec("DROP TRIGGER fail_review_request_outbox");
    expect(repository.createReviewRequest(actor, "request-failure", input).request).toMatchObject({
      reviewTaskKey: review.key,
      parentTaskKey: parent.key,
    });
  });

  it("rolls back the complete review audit graph when final submission append fails", async () => {
    const { database, repository, request, reviewer, reviewerSession, started, parent, hashes } =
      await readySubmission("RSUBF");
    const state = () => ({
      ...mutationCounts(database),
      submissions: database.sqlite.prepare("SELECT * FROM review_submissions").all(),
      records: database.sqlite.prepare("SELECT * FROM records ORDER BY local_no").all(),
      search: database.sqlite.prepare("SELECT * FROM search_documents ORDER BY entity_id").all(),
      tasks: database.sqlite
        .prepare(
          `SELECT id, status, phase, completed_at, computed_progress, reported_progress,
                  last_evidence_at, version FROM work_items ORDER BY local_no`,
        )
        .all(),
      checklist: database.sqlite
        .prepare("SELECT id, status, evidence_json, version FROM checklist_items ORDER BY id")
        .all(),
      session: database.sqlite
        .prepare(
          "SELECT work_state, current_work_item_id, version FROM agent_sessions WHERE id = ?",
        )
        .get(reviewerSession.id),
      counters: database.sqlite
        .prepare(
          "SELECT name, next_value FROM counters WHERE name IN ('record','review_submission') ORDER BY name",
        )
        .all(),
    });
    const before = state();
    database.sqlite.exec(`
      CREATE TRIGGER fail_review_submission_outbox
      BEFORE INSERT ON outbox
      WHEN NEW.payload_json LIKE '%review.submitted%'
      BEGIN
        SELECT RAISE(ABORT, 'injected review submission outbox failure');
      END;
    `);
    const input = {
      requestKey: request.request.key,
      expectedReviewTaskVersion: started.version,
      verdict: "APPROVED" as const,
      reviewedHashes: hashes,
      evidence: [{ kind: "test_result", value: "review tests passed" }],
    };

    expect(() => repository.submitReview(reviewer, "submission-failure", input)).toThrow(
      "injected review submission outbox failure",
    );
    expect(state()).toEqual(before);
    expect(repository.getReviewRequest(request.request.key).submission).toBeNull();

    database.sqlite.exec("DROP TRIGGER fail_review_submission_outbox");
    expect(repository.submitReview(reviewer, "submission-failure", input)).toMatchObject({
      verdict: "APPROVED",
      reviewTask: { status: "DONE" },
      parentChecklist: { id: parent.checklist[0]!.id, status: "DONE" },
    });
  });

  it("rolls back supersession, record counter and search when record append fails", async () => {
    const { database, repository, actor } = await fixture("RECF");
    const first = repository.createRecord(actor, "record-first", {
      kind: "FACT",
      title: "Original",
      summary: "Original record",
      topic: "atomic-record",
    });
    const firstView = repository.getRecord(first.key);
    const state = () => ({
      ...mutationCounts(database),
      records: database.sqlite.prepare("SELECT * FROM records ORDER BY local_no").all(),
      search: database.sqlite.prepare("SELECT * FROM search_documents ORDER BY entity_id").all(),
      counter: database.sqlite
        .prepare("SELECT next_value FROM counters WHERE name = 'record'")
        .get(),
    });
    const before = state();
    database.sqlite.exec(`
      CREATE TRIGGER fail_record_outbox
      BEFORE INSERT ON outbox
      WHEN NEW.payload_json LIKE '%record.created%'
      BEGIN
        SELECT RAISE(ABORT, 'injected record outbox failure');
      END;
    `);
    const input = {
      kind: "FACT",
      title: "Replacement",
      summary: "Replacement record",
      supersedes: firstView.id,
      topic: "atomic-record",
    };

    expect(() => repository.createRecord(actor, "record-failure", input)).toThrow(
      "injected record outbox failure",
    );
    expect(state()).toEqual(before);
    expect(repository.getRecord(first.key).status).toBe("ACTIVE");

    database.sqlite.exec("DROP TRIGGER fail_record_outbox");
    const replacement = repository.createRecord(actor, "record-failure", input);
    expect(repository.getRecord(first.key).status).toBe("SUPERSEDED");
    expect(repository.getRecord(replacement.key).supersedes).toBe(first.key);
  });
});

describe("Review and Record command facade boundary", () => {
  it("preserves public prototypes, nested public calls and facade-free command modules", async () => {
    for (const method of [
      "getReviewRequest",
      "createReviewRequest",
      "submitReview",
      "createRecord",
    ]) {
      expect(Object.getOwnPropertyDescriptor(ProjectRepository.prototype, method)?.value).toEqual(
        expect.any(Function),
      );
    }
    const repositorySource = readFileSync(
      resolve(process.cwd(), "packages/storage-sqlite/src/project-repository.ts"),
      "utf8",
    );
    for (const helper of ["reviewRequestRow", "reviewRequestKey", "reviewSubmissionKey"]) {
      expect(repositorySource).toMatch(new RegExp(`private ${helper}\\(`, "u"));
    }
    for (const file of ["review-commands.ts", "record-commands.ts"]) {
      const source = readFileSync(
        resolve(process.cwd(), "packages/storage-sqlite/src", file),
        "utf8",
      );
      expect(source).not.toMatch(/from\s+["']\.\/(?:index|manager|project-repository)\.js["']/u);
      expect(source).not.toMatch(/#sqlite\.transaction/u);
    }

    const requestFixture = await reviewFixture("RSPYQ");
    const getReviewRequest = vi.spyOn(requestFixture.repository, "getReviewRequest");
    requestFixture.repository.createReviewRequest(requestFixture.actor, "spy-request", {
      reviewTaskKey: requestFixture.review.key,
      expectedReviewTaskVersion: requestFixture.review.version,
      parentChecklistId: requestFixture.parent.checklist[0]!.id,
      expectedParentChecklistVersion: requestFixture.parent.checklist[0]!.version,
      expectedCandidateHashes: requestFixture.hashes,
    });
    expect(getReviewRequest).toHaveBeenCalledTimes(1);

    const submissionFixture = await readySubmission("RSPYS");
    const getSession = vi.spyOn(submissionFixture.repository, "getSession");
    submissionFixture.repository.submitReview(submissionFixture.reviewer, "spy-submission", {
      requestKey: submissionFixture.request.request.key,
      expectedReviewTaskVersion: submissionFixture.started.version,
      verdict: "CHANGES_REQUESTED",
      reviewedHashes: submissionFixture.hashes,
      evidence: [{ kind: "test_result", value: "reviewed" }],
    });
    expect(getSession).toHaveBeenCalledWith(submissionFixture.reviewerSession.id);
  });
});
