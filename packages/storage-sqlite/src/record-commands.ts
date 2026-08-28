import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import { createUlid, nowIso, RecordSummarySchema } from "@ayanami-task/protocol";
import { MutationRequestNormalizer } from "./mutation-request-normalizer.js";
import { ProjectMutationKernel, type MutationActor } from "./project-mutation-kernel.js";
import { RecordReadModel } from "./record-read-model.js";
import { TaskReadModel } from "./task-read-model.js";
import { WorkItemMaintenance } from "./work-item-maintenance.js";

export type CreateRecordInput = {
  kind: string;
  title: string;
  summary: string;
  detail?: string;
  importance?: string;
  scope?: string;
  workItemKey?: string | null;
  supersedes?: string | null;
  topic?: string | null;
  subjectKey?: string | null;
  sourceType?: "USER" | "AGENT" | "SYSTEM" | "IMPORT";
  sourceActorId?: string | null;
  sourceSessionId?: string | null;
  sourceRef?: string | null;
};

export type CreateRecordResult = {
  ok: 1;
  seq: number;
  key: string;
  v: number;
  relatedRecords: string[];
};

export class RecordCommands {
  readonly #sqlite: Database.Database;
  readonly #mutation: ProjectMutationKernel;
  readonly #requestNormalizer: MutationRequestNormalizer;
  readonly #taskReads: TaskReadModel;
  readonly #recordReads: RecordReadModel;
  readonly #maintenance: WorkItemMaintenance;
  readonly #projectCode: () => string;

  constructor(input: {
    sqlite: Database.Database;
    mutation: ProjectMutationKernel;
    requestNormalizer: MutationRequestNormalizer;
    taskReads: TaskReadModel;
    recordReads: RecordReadModel;
    maintenance: WorkItemMaintenance;
    projectCode: () => string;
  }) {
    this.#sqlite = input.sqlite;
    this.#mutation = input.mutation;
    this.#requestNormalizer = input.requestNormalizer;
    this.#taskReads = input.taskReads;
    this.#recordReads = input.recordReads;
    this.#maintenance = input.maintenance;
    this.#projectCode = input.projectCode;
  }

  createRecord(actor: MutationActor, opId: string, input: CreateRecordInput): CreateRecordResult {
    const normalizedInput = this.#requestNormalizer.normalize(
      "record.create",
      input,
    ) as typeof input;
    return this.#mutation.mutate({
      actor,
      opId,
      operation: "record.create",
      request: normalizedInput,
      action: () => {
        if (!RecordSummarySchema.safeParse(normalizedInput.summary).success) {
          throw new AtmError("VALIDATION_ERROR", {
            message: "记录摘要不能超过 300 字",
            details: { field: "summary", max: 300 },
          });
        }
        const id = createUlid();
        const localNo = this.#mutation.nextNumber("record");
        const key = `${this.#projectCode()}-${normalizedInput.kind === "DECISION" ? "D" : "R"}-${String(localNo).padStart(3, "0")}`;
        const workItemId = normalizedInput.workItemKey
          ? this.#taskReads.rowForTaskKey(normalizedInput.workItemKey).id
          : null;
        const now = nowIso();
        if (normalizedInput.supersedes) {
          const superseded = this.#sqlite
            .prepare("SELECT local_no, kind, scope FROM records WHERE id = ?")
            .get(normalizedInput.supersedes) as
            | { local_no: number; kind: string; scope: string }
            | undefined;
          if (superseded?.scope === "REVIEW_AUDIT") {
            const recordKey = this.#recordReads.recordKey(superseded);
            throw new AtmError("IMMUTABLE_RECORD", {
              message: `Review 审计记录不可替换：${recordKey}`,
              details: { record_key: recordKey },
            });
          }
          this.#sqlite
            .prepare(
              `UPDATE records SET status = 'SUPERSEDED', version = version + 1,
               updated_at = ? WHERE id = ?`,
            )
            .run(now, normalizedInput.supersedes);
        }
        this.#sqlite
          .prepare(
            `INSERT INTO records(
               id, local_no, kind, title, summary, detail, importance, status,
               supersedes_id, scope, work_item_id, actor, version, created_at, updated_at,
               source_type, source_actor_id, source_session_id, source_ref, topic, subject_key,
               op_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            localNo,
            normalizedInput.kind,
            normalizedInput.title,
            normalizedInput.summary,
            normalizedInput.detail ?? "",
            normalizedInput.importance ?? "NORMAL",
            normalizedInput.supersedes ?? null,
            normalizedInput.scope ?? "PROJECT",
            workItemId,
            actor.id,
            now,
            now,
            normalizedInput.sourceType ?? actor.type,
            normalizedInput.sourceActorId ?? actor.id,
            normalizedInput.sourceSessionId ?? actor.sessionId,
            normalizedInput.sourceRef ?? null,
            normalizedInput.topic ?? null,
            normalizedInput.subjectKey ?? null,
            opId,
          );
        const seq = this.#mutation.appendEvent("record.created", actor, "RECORD", id, {
          key,
          kind: normalizedInput.kind,
          title: normalizedInput.title,
          summary: normalizedInput.summary,
          topic: normalizedInput.topic ?? null,
          subjectKey: normalizedInput.subjectKey ?? null,
        });
        this.#maintenance.upsertSearchDocument(
          "RECORD",
          id,
          key,
          normalizedInput.title,
          `${normalizedInput.summary}\n${normalizedInput.detail ?? ""}`,
        );
        const relatedRecords = (
          this.#sqlite
            .prepare(
              `SELECT local_no, kind FROM records
               WHERE id <> ? AND status = 'ACTIVE' AND (
                 (? IS NOT NULL AND topic = ?) OR
                 (? IS NOT NULL AND subject_key = ?)
               ) ORDER BY updated_at DESC LIMIT 20`,
            )
            .all(
              id,
              normalizedInput.topic ?? null,
              normalizedInput.topic ?? null,
              normalizedInput.subjectKey ?? null,
              normalizedInput.subjectKey ?? null,
            ) as Array<{ local_no: number; kind: string }>
        ).map((row) => this.#recordReads.recordKey(row));
        return { ok: 1, seq, key, v: 0, relatedRecords };
      },
    });
  }
}
