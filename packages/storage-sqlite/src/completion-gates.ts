import type Database from "better-sqlite3";
import {
  AtmError,
  type CompletionGateFailedDetails,
  type CompletionGatePredicateName,
  type CompletionGateReason,
} from "@ayanami-task/errors";
import {
  COMPLETION_GATE_REQUIRED_STATUSES,
  legalWorkItemOperations,
  type WorkItemPhase,
  type WorkItemStatus,
} from "@ayanami-task/protocol";

export const COMPLETION_GATE_REASON_LIMIT_PER_PREDICATE = 50;

export const CompletionGatePredicateNames = [
  "checklist",
  "evidence",
  "children",
  "blockers",
  "dependencies",
  "verification",
  "current_state",
] as const satisfies readonly CompletionGatePredicateName[];

export type CompletionGateWorkItem = {
  readonly id: string;
  readonly status: WorkItemStatus;
  readonly phase?: WorkItemPhase | null;
  readonly verification_required: number;
};

type CompletionGateContext = {
  readonly sqlite: Database.Database;
  readonly workItem: CompletionGateWorkItem;
};

type PredicateResult = {
  readonly reasons: readonly CompletionGateReason[];
  readonly total: number;
};

export type CompletionGatePredicate = {
  readonly name: CompletionGatePredicateName;
  readonly evaluate: (context: CompletionGateContext) => PredicateResult;
};

function phaseFor(workItem: CompletionGateWorkItem): WorkItemPhase {
  return (workItem.phase ??
    (workItem.status === "WAITING_AGENT" || workItem.status === "WAITING_USER"
      ? "IN_PROGRESS"
      : workItem.status)) as WorkItemPhase;
}

function boundedEntityReasons(
  context: CompletionGateContext,
  query: string,
  parameters: readonly unknown[],
  reason: (id: string) => CompletionGateReason,
): PredicateResult {
  const rows = context.sqlite
    .prepare(query)
    .all(...parameters, COMPLETION_GATE_REASON_LIMIT_PER_PREDICATE) as Array<{
    id: unknown;
    total: number;
  }>;
  return {
    reasons: rows.map((row) => reason(String(row.id))),
    total: rows.length === 0 ? 0 : Number(rows[0]!.total),
  };
}

/**
 * Canonical, fixed-order completion registry. Entity predicates use a bounded window query:
 * every matching entity is counted, while only the first safe page is materialized.
 */
export const CompletionGates = [
  {
    name: "checklist",
    evaluate: (context) =>
      boundedEntityReasons(
        context,
        `SELECT id, COUNT(*) OVER () AS total
         FROM checklist_items
         WHERE work_item_id = ? AND kind <> 'OPTIONAL'
           AND status NOT IN ('DONE','SKIPPED')
         ORDER BY created_at, id
         LIMIT ?`,
        [context.workItem.id],
        (checklistId) => ({ code: "CHECKLIST_INCOMPLETE", checklist_id: checklistId }),
      ),
  },
  {
    name: "evidence",
    evaluate: (context) =>
      boundedEntityReasons(
        context,
        `SELECT id, COUNT(*) OVER () AS total
         FROM checklist_items
         WHERE work_item_id = ? AND evidence_required = 1
           AND status <> 'SKIPPED' AND (status <> 'DONE' OR evidence_json = '[]')
         ORDER BY created_at, id
         LIMIT ?`,
        [context.workItem.id],
        (checklistId) => ({ code: "EVIDENCE_MISSING", checklist_id: checklistId }),
      ),
  },
  {
    name: "children",
    evaluate: (context) =>
      boundedEntityReasons(
        context,
        `SELECT id, COUNT(*) OVER () AS total
         FROM work_items
         WHERE parent_id = ? AND archived_at IS NULL
           AND status NOT IN ('DONE','CANCELLED')
         ORDER BY local_no, id
         LIMIT ?`,
        [context.workItem.id],
        (workItemId) => ({ code: "CHILD_INCOMPLETE", work_item_id: workItemId }),
      ),
  },
  {
    name: "blockers",
    evaluate: (context) =>
      boundedEntityReasons(
        context,
        `SELECT id, COUNT(*) OVER () AS total
         FROM blockers
         WHERE work_item_id = ? AND status = 'ACTIVE'
         ORDER BY local_no, id
         LIMIT ?`,
        [context.workItem.id],
        (blockerId) => ({ code: "BLOCKER_ACTIVE", blocker_id: blockerId }),
      ),
  },
  {
    name: "dependencies",
    evaluate: (context) =>
      boundedEntityReasons(
        context,
        `SELECT source.id, COUNT(*) OVER () AS total
         FROM work_item_relations relation
         JOIN work_items source ON source.id = relation.source_id
         WHERE relation.target_id = ? AND relation.relation_type = 'BLOCKS'
           AND source.status <> 'DONE'
         ORDER BY source.local_no, source.id
         LIMIT ?`,
        [context.workItem.id],
        (workItemId) => ({ code: "DEPENDENCY_INCOMPLETE", work_item_id: workItemId }),
      ),
  },
  {
    name: "verification",
    evaluate: ({ workItem }) => {
      const reasons: CompletionGateReason[] =
        Number(workItem.verification_required) === 1 && workItem.status !== "VERIFYING"
          ? [{ code: "VERIFICATION_REQUIRED" }]
          : [];
      return { reasons, total: reasons.length };
    },
  },
  {
    name: "current_state",
    evaluate: ({ workItem }) => {
      const required: readonly string[] = COMPLETION_GATE_REQUIRED_STATUSES;
      // 已经 DONE 的任务没有「还差什么」可言，闸门对它无话可说。
      if (workItem.status === "DONE" || required.includes(workItem.status)) {
        return { reasons: [], total: 0 };
      }
      // 这条 reason 说的就是「complete 现在不行」，再把 complete 列进可用操作里
      // 等于自相矛盾——READY 任务过去拿到的正是这样一份提示。
      const legalOperations = legalWorkItemOperations(workItem.status, phaseFor(workItem))
        .filter((entry) => entry.operation !== "complete")
        .map((entry) => `${entry.operation} -> ${entry.target}`);
      return {
        reasons: [
          {
            code: "CURRENT_STATE_INVALID",
            current_status: workItem.status,
            required_status: [...COMPLETION_GATE_REQUIRED_STATUSES],
            legal_operations: legalOperations,
          },
        ],
        total: 1,
      };
    },
  },
] as const satisfies readonly CompletionGatePredicate[];

export function evaluateCompletionGates(
  sqlite: Database.Database,
  workItem: CompletionGateWorkItem,
): CompletionGateFailedDetails {
  const reasons: CompletionGateReason[] = [];
  const truncation: NonNullable<CompletionGateFailedDetails["truncation"]>[number][] = [];
  const context = { sqlite, workItem };

  for (const predicate of CompletionGates) {
    const result = predicate.evaluate(context);
    reasons.push(...result.reasons);
    if (result.total > result.reasons.length) {
      truncation.push({
        predicate: predicate.name,
        total: result.total,
        included: result.reasons.length,
        omitted: result.total - result.reasons.length,
      });
    }
  }

  return {
    reasons,
    truncated: truncation.length > 0,
    reason_limit_per_predicate: COMPLETION_GATE_REASON_LIMIT_PER_PREDICATE,
    truncation,
  };
}

export function assertCompletionGates(
  sqlite: Database.Database,
  workItem: CompletionGateWorkItem,
): void {
  const details = evaluateCompletionGates(sqlite, workItem);
  if (details.reasons.length === 0) return;
  throw new AtmError("COMPLETION_GATE_FAILED", {
    message: "WorkItem 尚未满足完成条件",
    details,
  });
}
