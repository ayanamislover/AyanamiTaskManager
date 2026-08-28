import { plain } from "../result.js";

export type TaskProjectionView = "core" | "context" | "full";
type TaskListView = TaskProjectionView | "reconcile";

function snakeCaseKey(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

/** MCP is the sole snake_case boundary; the canonical Application DTO remains camelCase. */
export function externalizeTaskView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(externalizeTaskView);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      snakeCaseKey(key),
      externalizeTaskView(entry),
    ]),
  );
}

export function compactReconciliationItem(item: Record<string, any>): Record<string, unknown> {
  const session = item.session && typeof item.session === "object" ? plain(item.session) : null;
  return {
    task_key: item.taskKey,
    title: item.title,
    status: item.status,
    classification: item.classification,
    reason: item.reason,
    age_seconds: item.ageSeconds,
    session: session
      ? {
          id: session.id,
          agent_id: session.agentId,
          display_name: session.displayName,
          connection_state: session.connectionState,
          last_seen_at: session.lastSeenAt ?? null,
          ended_at: session.endedAt ?? null,
        }
      : null,
    suggested_action: item.suggestedAction,
    evidence_paths: Array.isArray(item.evidencePaths) ? item.evidencePaths : [],
  };
}

export function fitTaskPage(
  project: string,
  view: TaskListView,
  maxChars: number,
  items: Array<Record<string, unknown>>,
  itemCursors: string[],
  sourceHasMore: boolean,
  sourceNextCursor: string | null,
  retryCursor: string,
): Record<string, unknown> {
  for (let count = items.length; count >= 0; count -= 1) {
    const returned = items.slice(0, count);
    const budgetTruncated = count < items.length;
    const hasMore = budgetTruncated || sourceHasMore;
    const nextCursor = hasMore
      ? count > 0
        ? (itemCursors[count - 1] ?? sourceNextCursor ?? retryCursor)
        : retryCursor
      : null;
    const candidate: Record<string, unknown> = {
      project: project.toUpperCase(),
      view,
      returned_count: returned.length,
      items: returned,
      next_cursor: nextCursor,
      has_more: hasMore,
      truncated: budgetTruncated,
      ...(budgetTruncated
        ? {
            truncated_collections: [
              {
                path: "items",
                original_items: items.length,
                returned_items: returned.length,
              },
            ],
          }
        : {}),
    };
    if (count === 0 && items.length > 0) {
      const firstItemChars = JSON.stringify(items[0]).length;
      candidate.oversized_item = {
        key: items[0]?.key,
        chars: firstItemChars,
        suggested_max_chars: Math.min(50_000, Math.max(maxChars + 1, firstItemChars + 800)),
        hint: "提高 max_chars，或用 field_mask 缩小列表投影，再以相同 cursor 重试",
      };
    }
    if (JSON.stringify(candidate).length <= maxChars) return candidate;
  }
  return {
    project: project.toUpperCase(),
    view,
    returned_count: 0,
    items: [],
    next_cursor: retryCursor,
    has_more: items.length > 0 || sourceHasMore,
    truncated: items.length > 0,
  };
}

export function fitReconciliationPage(
  projectCode: string,
  reconciliation: Record<string, any>,
  offset: number,
  maxChars: number,
  items: Array<Record<string, unknown>>,
  sourceHasMore: boolean,
): Record<string, unknown> {
  const project = plain(reconciliation.project);
  for (let count = items.length; count >= 1; count -= 1) {
    const returned = items.slice(0, count);
    const budgetTruncated = count < items.length;
    const hasMore = budgetTruncated || sourceHasMore;
    const candidate: Record<string, unknown> = {
      project: String(project.code ?? projectCode).toUpperCase(),
      project_name: project.name ?? null,
      source_root: project.sourceRoot ?? null,
      view: "reconcile",
      generated_at: reconciliation.generatedAt,
      attention_count: reconciliation.attentionCount,
      counts: reconciliation.counts,
      returned_count: returned.length,
      items: returned,
      next_cursor: hasMore ? String(offset + returned.length) : null,
      has_more: hasMore,
      truncated: budgetTruncated,
    };
    if (JSON.stringify(candidate).length <= maxChars) return candidate;
  }
  const first = items[0];
  if (first) {
    const identityKeys = ["task_key", "classification"];
    const identity = Object.fromEntries(
      identityKeys.filter((key) => key in first).map((key) => [key, first[key]]),
    );
    const hasMore = items.length > 1 || sourceHasMore;
    const omittedFields = Object.keys(first).filter((key) => !identityKeys.includes(key));
    const truncatedItem = {
      project: String(project.code ?? projectCode).toUpperCase(),
      view: "reconcile",
      returned_count: 1,
      items: [identity],
      next_cursor: hasMore ? String(offset + 1) : null,
      has_more: hasMore,
      truncated: true,
      truncation: {
        path: "items[0]",
        retry_cursor: String(offset),
        omitted_fields: omittedFields,
      },
    };
    if (JSON.stringify(truncatedItem).length <= maxChars) return truncatedItem;
  }
  return {
    project: projectCode.toUpperCase(),
    view: "reconcile",
    returned_count: 0,
    items: [],
    next_cursor: items.length > 0 || sourceHasMore ? String(offset) : null,
    has_more: items.length > 0 || sourceHasMore,
    truncated: items.length > 0,
  };
}
