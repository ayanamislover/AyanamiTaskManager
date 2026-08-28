import { AtmError } from "@ayanami-task/errors";
import type { ProjectRepository, SessionView } from "@ayanami-task/storage-sqlite";
import { reconcileWorkItems } from "../reconcile.js";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";

export async function reconcileProject(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  input: { includeActive?: boolean } = {},
) {
  const project = runtime.databases.getProject(projectCode);
  const repository = await runtime.repository(project.code);
  const tasks: ReturnType<ProjectRepository["listWorkItems"]> = [];
  let taskCursor: string | undefined;
  const seenTaskCursors = new Set<string>();
  for (;;) {
    const page = repository.listWorkItemPage({
      limit: 100,
      ...(taskCursor === undefined ? {} : { cursor: taskCursor }),
    });
    tasks.push(...page.items);
    if (!page.hasMore) break;
    if (!page.nextCursor) {
      throw new AtmError("INVALID_RESPONSE", {
        message: "RECONCILE_TASK_PAGE 分页声明 hasMore=true 但未返回 nextCursor",
        details: { entity: "RECONCILE_TASK_PAGE", reason: "MISSING_NEXT_CURSOR" },
      });
    }
    if (seenTaskCursors.has(page.nextCursor)) {
      throw new AtmError("INVALID_RESPONSE", {
        message: "RECONCILE_TASK_PAGE 分页返回了重复 cursor",
        details: { entity: "RECONCILE_TASK_PAGE", reason: "REPEATED_CURSOR" },
      });
    }
    seenTaskCursors.add(page.nextCursor);
    taskCursor = page.nextCursor;
  }

  const sessions: SessionView[] = [];
  let sessionCursor: string | undefined;
  const seenSessionCursors = new Set<string>();
  for (;;) {
    const page = repository.listAgentSessionPage({
      limit: 100,
      ...(sessionCursor === undefined ? {} : { cursor: sessionCursor }),
    });
    sessions.push(...page.items);
    if (!page.hasMore) break;
    if (!page.nextCursor) {
      throw new AtmError("INVALID_RESPONSE", {
        message: "RECONCILE_SESSION_PAGE 分页声明 hasMore=true 但未返回 nextCursor",
        details: { entity: "RECONCILE_SESSION_PAGE", reason: "MISSING_NEXT_CURSOR" },
      });
    }
    if (seenSessionCursors.has(page.nextCursor)) {
      throw new AtmError("INVALID_RESPONSE", {
        message: "RECONCILE_SESSION_PAGE 分页返回了重复 cursor",
        details: { entity: "RECONCILE_SESSION_PAGE", reason: "REPEATED_CURSOR" },
      });
    }
    seenSessionCursors.add(page.nextCursor);
    sessionCursor = page.nextCursor;
  }
  const knownSessionIds = new Set(sessions.map((session) => String(session.id)));
  for (const task of tasks) {
    const sessionId = task.claimedBySessionId;
    if (!sessionId || knownSessionIds.has(sessionId)) continue;
    try {
      sessions.push(repository.getSessionView(sessionId));
      knownSessionIds.add(sessionId);
    } catch {
      // Missing claim owners remain visible as stalled rather than making reconciliation fail.
    }
  }

  const result = reconcileWorkItems({
    sourceRoot: project.sourcePaths[0] ?? null,
    tasks,
    sessions,
    includeActive: input.includeActive ?? false,
  });
  return {
    project: {
      code: project.code,
      name: project.name,
      sourceRoot: project.sourcePaths[0] ?? null,
    },
    ...result,
  };
}

export async function reconcileProjectPage(
  projectCode: string,
  input: { includeActive?: boolean; limit?: number; cursor?: string },
  reconcile: (
    projectCode: string,
    input: { includeActive?: boolean },
  ) => ReturnType<typeof reconcileProject>,
) {
  const limit = Math.min(100, Math.max(1, input.limit ?? 10));
  const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
  const reconciliation = await reconcile(projectCode, {
    includeActive: input.includeActive ?? false,
  });
  const items = reconciliation.items.slice(offset, offset + limit);
  const hasMore = offset + items.length < reconciliation.items.length;
  return {
    ...reconciliation,
    offset,
    returnedCount: items.length,
    items,
    retryCursor: String(offset),
    nextCursor: hasMore ? String(offset + items.length) : null,
    hasMore,
  };
}
