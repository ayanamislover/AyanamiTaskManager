import { AtmError } from "@ayanami-task/errors";
import { type TaskView, type TaskViewName } from "@ayanami-task/protocol";
import {
  type ProjectRepository,
  type WorkItemListFilters,
  type WorkItemPageFilters,
} from "@ayanami-task/storage-sqlite";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";
import { projectTaskView } from "./task-views.js";

function assertKnownMilestones(
  repository: ProjectRepository,
  milestoneIds: Iterable<string | null | undefined>,
): void {
  const requested = new Set(
    Array.from(milestoneIds).filter(
      (milestoneId): milestoneId is string => typeof milestoneId === "string",
    ),
  );
  if (requested.size === 0) return;
  const known = new Set(repository.listMilestones().map((milestone) => String(milestone.id)));
  for (const milestoneId of requested) {
    if (!known.has(milestoneId)) {
      throw new AtmError("MILESTONE_NOT_FOUND", {
        message: `里程碑不存在：${milestoneId}`,
        details: { entity: "MILESTONE", reference: milestoneId },
      });
    }
  }
}

export async function listWorkItems(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  filters: Parameters<ProjectRepository["listWorkItems"]>[0] | undefined,
  view: TaskViewName,
): Promise<TaskView[]> {
  const repository = await runtime.repository(projectCode);
  assertKnownMilestones(repository, [filters?.milestoneId]);
  return repository
    .listTaskViewRows(filters, view)
    .map((row) => projectTaskView(projectCode, row, view));
}

export async function listWorkItemPage(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  filters: WorkItemPageFilters,
  view: TaskViewName,
): Promise<{
  items: TaskView[];
  itemCursors: string[];
  nextCursor: string | null;
  retryCursor: string;
  hasMore: boolean;
}> {
  const repository = await runtime.repository(projectCode);
  assertKnownMilestones(repository, [filters.milestoneId]);
  const page = repository.listTaskViewPage(filters, view);
  return {
    ...page,
    items: page.items.map((row) => projectTaskView(projectCode, row, view)),
  };
}

export async function listWorkItemPageForUi(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  filters: WorkItemPageFilters,
): Promise<ReturnType<ProjectRepository["listWorkItemPage"]>> {
  const repository = await runtime.repository(projectCode);
  assertKnownMilestones(repository, [filters.milestoneId]);
  return repository.listWorkItemPage(filters);
}

export async function listWorkItemsForUi(
  projectCode: string,
  filters: WorkItemListFilters,
  listPage: (
    projectCode: string,
    filters: WorkItemPageFilters,
  ) => Promise<ReturnType<ProjectRepository["listWorkItemPage"]>>,
): Promise<ReturnType<ProjectRepository["listWorkItems"]>> {
  const { offset = 0, ...pageFilters } = filters;
  const items: ReturnType<ProjectRepository["listWorkItems"]> = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let pageCount = 0; ; pageCount += 1) {
    if (pageCount >= 100 || items.length >= 10_000) {
      throw new AtmError("RESULT_TOO_LARGE", {
        message: "UI WorkItem 读取达到安全上限，请使用分页接口继续",
        details: {
          entity: "TASK_UI_PAGE",
          reason: "DRAIN_LIMIT_REACHED",
          maxPages: 100,
          maxItems: 10_000,
          resumeCursor: cursor ?? null,
        },
      });
    }
    const page = await listPage(projectCode, {
      ...pageFilters,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    if (!page.hasMore) return items.slice(Math.max(0, offset));
    if (!page.nextCursor) {
      throw new AtmError("INVALID_RESPONSE", {
        message: "TASK_UI_PAGE 分页声明 hasMore=true 但未返回 nextCursor",
        details: { entity: "TASK_UI_PAGE", reason: "MISSING_NEXT_CURSOR" },
      });
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new AtmError("INVALID_RESPONSE", {
        message: "TASK_UI_PAGE 分页返回了重复 cursor",
        details: { entity: "TASK_UI_PAGE", reason: "REPEATED_CURSOR" },
      });
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export async function assertMilestonesExist(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  milestoneIds: Array<string | null | undefined>,
): Promise<void> {
  assertKnownMilestones(await runtime.repository(projectCode), milestoneIds);
}

export async function getWorkItem(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  taskKey: string,
  view?: TaskViewName,
): Promise<TaskView | ReturnType<ProjectRepository["getWorkItem"]>> {
  const repository = await runtime.repository(projectCode);
  if (view === undefined) return repository.getWorkItem(taskKey);
  return projectTaskView(projectCode, repository.getTaskViewRow(taskKey, view), view);
}

export async function getWorkItemForUi(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  taskKey: string,
): Promise<ReturnType<ProjectRepository["getWorkItem"]>> {
  return (await runtime.repository(projectCode)).getWorkItem(taskKey);
}
