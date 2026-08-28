import {
  asAtmError,
  AtmError,
  rankSuggestions,
  type AtmBaseErrorDetails,
} from "@ayanami-task/errors";
import type { ProjectRepository } from "@ayanami-task/storage-sqlite";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";

export type PublicNotFoundDetails = {
  entity: "PROJECT" | "WORK_ITEM" | "SESSION" | "MILESTONE";
  did_you_mean: string | null;
  candidates: Array<Record<string, string>>;
  candidate_count: number;
  candidate_scan_count: number;
  candidate_scan_truncated: boolean;
  candidates_truncated: boolean;
};

type ErrorEnrichmentContext = {
  projectCode?: string;
  taskKey?: string;
  checklistId?: string;
  expectedVersion?: number;
  expectedVersions?: Record<string, number>;
};

type ErrorEnrichmentQueries = {
  notFoundSuggestionDetails: (
    projectCode: string,
    code: string,
    reference: string,
  ) => Promise<PublicNotFoundDetails | null>;
  projectSuggestionDetails: (reference: string) => PublicNotFoundDetails;
  checklistConflictSnapshot: (
    projectCode: string,
    checklistId: string,
  ) => Promise<ReturnType<ProjectRepository["checklistConflictSnapshot"]>>;
  recentChecklistChanges: (
    projectCode: string,
    checklistId: string,
    limit?: number,
  ) => Promise<ReturnType<ProjectRepository["recentChecklistChanges"]>>;
  getWorkItemForUi: (
    projectCode: string,
    taskKey: string,
  ) => Promise<ReturnType<ProjectRepository["getWorkItem"]>>;
  recentWorkItemChanges: (
    projectCode: string,
    taskKey: string,
    limit?: number,
  ) => Promise<ReturnType<ProjectRepository["recentWorkItemChanges"]>>;
};

function rankPublicCandidates<T extends Record<string, string>>(
  queryValue: string,
  candidates: T[],
  identities: (candidate: T) => readonly string[],
  candidateCount = candidates.length,
): Omit<PublicNotFoundDetails, "entity"> & { candidates: T[] } {
  const ranked = rankSuggestions(queryValue, candidates, identities);
  return {
    did_you_mean: ranked.didYouMean,
    candidates: ranked.candidates,
    candidate_count: candidateCount,
    candidate_scan_count: candidates.length,
    candidate_scan_truncated: candidates.length < candidateCount,
    candidates_truncated: ranked.candidates.length < candidateCount,
  };
}

export async function notFoundSuggestionDetails(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  code: string,
  reference: string,
): Promise<PublicNotFoundDetails | null> {
  const repository = await runtime.repository(projectCode);
  if (code === "WORK_ITEM_NOT_FOUND") {
    const summary = repository.workItemSuggestionCandidates(reference, 50);
    const candidates = summary.candidates.slice(0, 5);
    const plausible = rankSuggestions(reference, summary.candidates, (candidate) => [
      candidate.key,
    ]).didYouMean;
    return {
      entity: "WORK_ITEM",
      did_you_mean: plausible === null ? null : (candidates[0]?.key ?? null),
      candidates,
      candidate_count: summary.total,
      candidate_scan_count: summary.candidates.length,
      candidate_scan_truncated: summary.candidates.length < summary.total,
      candidates_truncated: candidates.length < summary.total,
    };
  }
  if (code === "SESSION_NOT_FOUND") {
    const candidateCount = repository.countAgentSessions();
    const candidates: Array<{
      id: string;
      connectionState: string;
      workState: string;
    }> = [];
    let cursor: string | undefined;
    while (candidates.length < 200) {
      const page = repository.listAgentSessionPage({
        limit: Math.min(100, 200 - candidates.length),
        ...(cursor === undefined ? {} : { cursor }),
      });
      candidates.push(
        ...page.items.map((session) => ({
          id: session.id,
          connectionState: session.connectionState,
          workState: session.workState,
        })),
      );
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const ranked = rankPublicCandidates(
      reference,
      candidates,
      (candidate) => [candidate.id],
      candidateCount,
    );
    return { entity: "SESSION", ...ranked };
  }
  if (code === "MILESTONE_NOT_FOUND") {
    const ranked = rankPublicCandidates(
      reference,
      repository.listMilestones().map((milestone) => ({
        id: String(milestone.id),
        status: String(milestone.status),
      })),
      (candidate) => [candidate.id],
    );
    return { entity: "MILESTONE", ...ranked };
  }
  return null;
}

export function projectSuggestionDetails(
  runtime: ApplicationServiceRuntime,
  reference: string,
): PublicNotFoundDetails {
  const candidates = runtime.databases
    .listProjects()
    .filter((project) => project.lifecycle !== "TRASHED")
    .map((project) => ({ code: project.code, name: project.name }));
  const ranked = rankPublicCandidates(reference, candidates, (candidate) => [
    candidate.code,
    candidate.name,
  ]);
  return { entity: "PROJECT", ...ranked };
}

export async function enrichApplicationError(
  queries: ErrorEnrichmentQueries,
  error: unknown,
  context: ErrorEnrichmentContext = {},
): Promise<AtmError> {
  const typed = asAtmError(error);
  const source = (typed.details ?? {}) as AtmBaseErrorDetails;
  const reference = typeof source.reference === "string" ? source.reference : null;
  if (typed.code === "PROJECT_NOT_FOUND" && reference) {
    try {
      const suggestion = queries.projectSuggestionDetails(reference);
      return typed.withDetails({
        ...source,
        entity: "PROJECT",
        reference,
        did_you_mean: suggestion.did_you_mean,
        candidates: suggestion.candidates,
      });
    } catch {
      return typed;
    }
  }
  if (
    reference &&
    context.projectCode &&
    ["WORK_ITEM_NOT_FOUND", "SESSION_NOT_FOUND", "MILESTONE_NOT_FOUND"].includes(typed.code)
  ) {
    try {
      const suggestion = await queries.notFoundSuggestionDetails(
        context.projectCode,
        typed.code,
        reference,
      );
      if (suggestion) return typed.withDetails({ ...source, ...suggestion, reference });
    } catch {
      return typed;
    }
  }
  if (typed.code !== "VERSION_CONFLICT") return typed;
  const expected =
    typeof source.expected === "number"
      ? source.expected
      : context.taskKey
        ? (context.expectedVersions?.[context.taskKey] ?? context.expectedVersion ?? null)
        : (context.expectedVersion ?? null);
  const actual = typeof source.actual === "number" ? source.actual : null;
  if (actual === null) return typed;
  const entity = typeof source.entity === "string" ? source.entity : null;
  const key = typeof source.key === "string" ? source.key : null;
  const base: Record<string, unknown> = {
    ...source,
    ...(expected === null ? {} : { expected, expected_version: expected }),
    actual,
    current_version: actual,
    ...(expected === null ? {} : { version_gap: actual - expected }),
  };
  if (!context.projectCode) return typed.withDetails(base as AtmBaseErrorDetails);
  try {
    if ((entity === "CHECKLIST" || context.checklistId) && (key || context.checklistId)) {
      const checklistId = String(key ?? context.checklistId);
      const [current, recentChanges] = await Promise.all([
        queries.checklistConflictSnapshot(context.projectCode, checklistId),
        queries.recentChecklistChanges(context.projectCode, checklistId, 6),
      ]);
      return typed.withDetails({
        ...base,
        entity: "CHECKLIST",
        key: checklistId,
        checklist_id: checklistId,
        task_key: current.taskKey,
        current: {
          id: current.id,
          task_key: current.taskKey,
          task_version: current.taskVersion,
          title: current.title,
          status: current.status,
          evidence_required: current.evidenceRequired,
          evidence_count: current.evidenceCount,
          version: current.version,
          updated_at: current.updatedAt,
        },
        recent_changes: recentChanges.slice(0, 6).map((change) => ({
          seq: change.seq,
          type: change.type,
          key: change.key,
          summary: change.summary,
          op_id: change.opId,
          at: change.at,
        })),
        changes_complete: false,
      });
    }
    const taskKey = String(key ?? context.taskKey ?? "");
    if ((entity === "WORK_ITEM" || context.taskKey) && taskKey) {
      const [current, recentChanges] = await Promise.all([
        queries.getWorkItemForUi(context.projectCode, taskKey),
        queries.recentWorkItemChanges(context.projectCode, taskKey, 6),
      ]);
      return typed.withDetails({
        ...base,
        entity: "WORK_ITEM",
        key: taskKey,
        task_key: taskKey,
        current: {
          key: current.key,
          version: current.version,
          status: current.status,
          phase: current.phase,
          title: current.title,
          description: current.description,
          assignee_agent_id: current.assigneeAgentId,
          claimed_by_session_id: current.claimedBySessionId,
          target_date: current.targetDate,
          parent_key: current.parentKey,
          cancel_reason: current.cancelReason,
          duplicate_of: current.duplicateOf,
          superseded_by: current.supersededBy,
          updated_at: current.updatedAt,
        },
        recent_changes: recentChanges.slice(0, 6).map((change) => ({
          seq: change.seq,
          type: change.type,
          key: change.key,
          summary: change.summary,
          op_id: change.opId,
          at: change.at,
        })),
        changes_complete: false,
      });
    }
  } catch {
    return typed.withDetails(base as AtmBaseErrorDetails);
  }
  return typed.withDetails(base as AtmBaseErrorDetails);
}
