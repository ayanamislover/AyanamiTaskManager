import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import { createUlid, nowIso, type EvidenceInput } from "@ayanami-task/protocol";
import type { MutationActor, MutationInput } from "./project-mutation-kernel.js";

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

type ProjectUpdateDependencies = {
  sqlite: Database.Database;
  meta: () => { code: string; sequence: number };
  mutate: <T>(input: MutationInput<T>) => T;
  appendEvent: (
    type: string,
    actor: MutationActor,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
  ) => number;
  listWorkItems: (filters: { limit: number }) => Array<{ status: string; title: string }>;
  listProjectUpdates: (limit?: number) => any[];
  normalizeEvidence: (evidence: unknown[], strictTyped?: boolean) => unknown[];
  rowForTaskKey: (taskKey: string) => { id: string };
  taskKeyForId: (workItemId: string) => string | null;
  advanceWorkItemEvidenceAt: (workItemId: string, at: string) => void;
};

/** Owns project-update drafting, publication, and its bounded read model. */
export class ProjectUpdateCommands {
  readonly #sqlite: Database.Database;
  readonly #dependencies: Omit<ProjectUpdateDependencies, "sqlite">;

  constructor(dependencies: ProjectUpdateDependencies) {
    this.#sqlite = dependencies.sqlite;
    this.#dependencies = dependencies;
  }

  projectUpdateView(row: any): any {
    return {
      id: row.id,
      health: row.health,
      summary: row.summary,
      completed: json(row.completed_json, []),
      risks: json(row.risks_json, []),
      next: json(row.next_json, []),
      evidence: json(row.evidence_json, []),
      fromSequence: row.from_sequence,
      toSequence: row.to_sequence,
      status: row.status,
      actor: row.actor,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      opId: row.op_id ?? null,
      sessionId: row.session_id ?? null,
    };
  }

  getProjectUpdate(id: string): any {
    const normalized = id.trim();
    const row = this.#sqlite.prepare("SELECT * FROM project_updates WHERE id = ?").get(normalized);
    if (!row)
      throw new AtmError("PROJECT_UPDATE_NOT_FOUND", {
        message: `项目更新不存在：${normalized}`,
        details: { entity: "PROJECT_UPDATE", reference: normalized },
      });
    return this.projectUpdateView(row);
  }

  listProjectUpdates(limit = 50): any[] {
    return (
      this.#sqlite
        .prepare(
          `SELECT id, health, summary, completed_json, risks_json, next_json, evidence_json,
                from_sequence, to_sequence, status, actor, published_at, created_at, updated_at,
                op_id, session_id
         FROM project_updates ORDER BY created_at DESC LIMIT ?`,
        )
        .all(Math.min(100, Math.max(1, limit))) as any[]
    ).map((row) => this.projectUpdateView(row));
  }

  draftProjectUpdate(actor: MutationActor, opId: string): any {
    return this.#dependencies.mutate({
      actor,
      opId,
      operation: "project-update.draft",
      request: {},
      action: () => {
        const meta = this.#sqlite
          .prepare("SELECT * FROM project_meta WHERE singleton = 1")
          .get() as any;
        const last = this.#sqlite
          .prepare(
            "SELECT to_sequence FROM project_updates WHERE status = 'PUBLISHED' ORDER BY published_at DESC LIMIT 1",
          )
          .get() as { to_sequence: number } | undefined;
        const fromSequence = last?.to_sequence ?? 0;
        const toSequence = meta.current_sequence;
        const completed = (
          this.#sqlite
            .prepare(
              `SELECT item.title FROM events event
             JOIN work_items item ON item.id = event.aggregate_id
             WHERE event.sequence > ? AND event.sequence <= ? AND event.type = 'work.completed'
             ORDER BY event.sequence DESC LIMIT 10`,
            )
            .all(fromSequence, toSequence) as Array<{ title: string }>
        ).map((row) => row.title);
        const risks = (
          this.#sqlite
            .prepare(
              `SELECT COALESCE(blocked_reason, waiting_for, title) AS value FROM work_items
             WHERE status IN ('BLOCKED','WAITING_USER','WAITING_AGENT') AND archived_at IS NULL
             ORDER BY updated_at DESC LIMIT 10`,
            )
            .all() as Array<{ value: string }>
        ).map((row) => row.value);
        const next = this.#dependencies
          .listWorkItems({ limit: 5 })
          .filter((item) => ["READY", "CLAIMED", "IN_PROGRESS"].includes(item.status))
          .map((item) => item.title);
        const summary = `${completed.length ? `完成 ${completed.length} 项` : "暂无新增完成项"}；${risks.length ? `存在 ${risks.length} 项风险` : "当前无阻塞风险"}`;
        const id = createUlid();
        const now = nowIso();
        this.#sqlite
          .prepare(
            `INSERT INTO project_updates(
               id, health, summary, completed_json, risks_json, next_json,
               from_sequence, to_sequence, status, actor, published_at, created_at, updated_at,
               op_id, session_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, NULL, ?, ?, ?, ?)`,
          )
          .run(
            id,
            meta.health,
            summary,
            JSON.stringify(completed),
            JSON.stringify(risks),
            JSON.stringify(next),
            fromSequence,
            toSequence,
            actor.id,
            now,
            now,
            opId,
            actor.sessionId,
          );
        const seq = this.#dependencies.appendEvent(
          "project.update.drafted",
          actor,
          "PROJECT_UPDATE",
          id,
          { fromSequence, toSequence },
        );
        return {
          ...this.#dependencies.listProjectUpdates(100).find((update) => update.id === id),
          seq,
        };
      },
    });
  }

  publishProjectUpdate(
    actor: MutationActor,
    opId: string,
    input: {
      draftId?: string | null;
      health: "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "UNKNOWN";
      summary: string;
      completed?: Array<string | { text: string; workItemKey?: string }>;
      risks?: string[];
      next?: string[];
      evidence?: EvidenceInput[];
    },
  ): any {
    const normalizedInput = {
      ...input,
      ...(input.evidence === undefined
        ? {}
        : {
            evidence: this.#dependencies.normalizeEvidence(input.evidence, true) as EvidenceInput[],
          }),
      ...(input.completed === undefined
        ? {}
        : {
            completed: input.completed.map((entry) => {
              if (typeof entry === "string" || entry.workItemKey === undefined) return entry;
              const row = this.#dependencies.rowForTaskKey(entry.workItemKey);
              return {
                ...entry,
                workItemKey: this.#dependencies.taskKeyForId(row.id)!,
              };
            }),
          }),
    };
    return this.#dependencies.mutate({
      actor,
      opId,
      operation: "project-update.publish",
      request: normalizedInput,
      action: () => {
        const draft = normalizedInput.draftId
          ? (this.#sqlite
              .prepare("SELECT * FROM project_updates WHERE id = ? AND status = 'DRAFT'")
              .get(normalizedInput.draftId) as any)
          : null;
        if (normalizedInput.draftId && !draft)
          throw new AtmError("PROJECT_UPDATE_DRAFT_NOT_FOUND", {
            message: `项目更新草稿不存在：${normalizedInput.draftId}`,
            details: { entity: "PROJECT_UPDATE_DRAFT", reference: normalizedInput.draftId },
          });
        const id = draft?.id ?? createUlid();
        const now = nowIso();
        const meta = this.#dependencies.meta();
        const completed = normalizedInput.completed ?? json(draft?.completed_json, []);
        const risks = normalizedInput.risks ?? json(draft?.risks_json, []);
        const next = normalizedInput.next ?? json(draft?.next_json, []);
        const evidence = normalizedInput.evidence ?? json(draft?.evidence_json, []);
        const fromSequence =
          draft?.from_sequence ??
          (
            this.#sqlite
              .prepare(
                "SELECT MAX(to_sequence) AS value FROM project_updates WHERE status = 'PUBLISHED'",
              )
              .get() as { value: number | null }
          ).value ??
          0;
        const toSequence = draft?.to_sequence ?? meta.sequence;
        if (draft) {
          this.#sqlite
            .prepare(
              `UPDATE project_updates SET health = ?, summary = ?, completed_json = ?, risks_json = ?,
               next_json = ?, evidence_json = ?, status = 'PUBLISHED', actor = ?, published_at = ?,
               updated_at = ?, op_id = ?, session_id = ? WHERE id = ?`,
            )
            .run(
              normalizedInput.health,
              normalizedInput.summary.trim(),
              JSON.stringify(completed),
              JSON.stringify(risks),
              JSON.stringify(next),
              JSON.stringify(evidence),
              actor.id,
              now,
              now,
              opId,
              actor.sessionId,
              id,
            );
        } else {
          this.#sqlite
            .prepare(
              `INSERT INTO project_updates(
                 id, health, summary, completed_json, risks_json, next_json, evidence_json,
                 from_sequence, to_sequence, status, actor, published_at, created_at, updated_at,
                 op_id, session_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              normalizedInput.health,
              normalizedInput.summary.trim(),
              JSON.stringify(completed),
              JSON.stringify(risks),
              JSON.stringify(next),
              JSON.stringify(evidence),
              fromSequence,
              toSequence,
              actor.id,
              now,
              now,
              now,
              opId,
              actor.sessionId,
            );
        }
        this.#sqlite
          .prepare(
            "UPDATE project_meta SET health = ?, version = version + 1, updated_at = ? WHERE singleton = 1",
          )
          .run(normalizedInput.health, now);
        const seq = this.#dependencies.appendEvent(
          "project.update.published",
          actor,
          "PROJECT_UPDATE",
          id,
          {
            health: normalizedInput.health,
            summary: normalizedInput.summary.trim(),
          },
        );
        const linkedKeys = new Set(
          completed.flatMap((entry: string | { text: string; workItemKey?: string }) =>
            typeof entry === "string" || !entry.workItemKey ? [] : [entry.workItemKey],
          ),
        );
        if (evidence.length > 0) {
          for (const taskKey of linkedKeys) {
            this.#dependencies.advanceWorkItemEvidenceAt(
              this.#dependencies.rowForTaskKey(taskKey).id,
              now,
            );
          }
        }
        const openWorkItemSummary = this.#openWorkItemSummary(linkedKeys, 20);
        return {
          ...this.#dependencies.listProjectUpdates(100).find((update) => update.id === id),
          seq,
          opId,
          unlinked: completed.length > 0 && openWorkItemSummary.total > 0,
          openWorkItemCount: openWorkItemSummary.total,
          openWorkItems: openWorkItemSummary.keys,
          openWorkItemsTruncated: openWorkItemSummary.truncated,
        };
      },
    });
  }

  #openWorkItemSummary(
    excludedTaskKeys: ReadonlySet<string>,
    limit: number,
  ): { keys: string[]; total: number; truncated: boolean } {
    const excludedIds = [...excludedTaskKeys].map(
      (key) => this.#dependencies.rowForTaskKey(key).id,
    );
    const clauses = ["archived_at IS NULL", "status NOT IN ('DONE','CANCELLED')"];
    const parameters: unknown[] = [];
    if (excludedIds.length > 0) {
      clauses.push(`id NOT IN (${excludedIds.map(() => "?").join(", ")})`);
      parameters.push(...excludedIds);
    }
    const where = clauses.join(" AND ");
    const countRow = this.#sqlite
      .prepare(`SELECT COUNT(*) AS count FROM work_items WHERE ${where}`)
      .get(...parameters) as { count: number };
    const boundedLimit = Math.min(100, Math.max(1, limit));
    const rows = this.#sqlite
      .prepare(
        `SELECT local_no FROM work_items WHERE ${where}
         ORDER BY CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
           WHEN 'NORMAL' THEN 2 ELSE 3 END, sort_key, created_at, local_no LIMIT ?`,
      )
      .all(...parameters, boundedLimit) as Array<{ local_no: number }>;
    const total = Number(countRow.count);
    const code = this.#dependencies.meta().code;
    const keys = rows.map((row) => `${code}-T-${String(row.local_no).padStart(4, "0")}`);
    return { keys, total, truncated: keys.length < total };
  }
}
