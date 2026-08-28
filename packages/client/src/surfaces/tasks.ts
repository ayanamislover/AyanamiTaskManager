import type { TaskViewName } from "@ayanami-task/protocol";
import { drainCursorPages, type CursorDrainOptions, type CursorPage } from "../cursor-drain.js";
import { AyanamiClientError, queryString, type ClientRequest } from "../http.js";
import type { TaskListFilters, TaskPage, TaskViewFor } from "../types.js";

export function createTasksSurface(request: ClientRequest) {
  return {
    page: <TView extends TaskViewName = "core">(
      project: string,
      filters: TaskListFilters<TView> = {},
    ) =>
      request<TaskPage<TView>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(project)}/work-items${queryString(filters)}`,
      ),
    taskPage: <TView extends TaskViewName = "core">(
      project: string,
      filters: TaskListFilters<TView> = {},
    ) =>
      request<TaskPage<TView>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(project)}/work-items${queryString(filters)}`,
      ),
    list: <TView extends TaskViewName = "core">(
      project: string,
      filters: TaskListFilters<TView> = {},
      options: CursorDrainOptions = {},
    ): Promise<Array<TaskViewFor<TView>>> => {
      const { cursor: initialCursor, ...pageFilters } = filters;
      return drainCursorPages(
        (cursor) =>
          request<TaskPage<TView>>(
            "GET",
            `/api/v1/projects/${encodeURIComponent(project)}/work-items${queryString({
              ...pageFilters,
              cursor,
            })}`,
          ),
        {
          ...options,
          ...((options.initialCursor ?? initialCursor)
            ? { initialCursor: options.initialCursor ?? initialCursor }
            : {}),
          entity: "TASK_PAGE",
          errorClass: AyanamiClientError,
        },
      );
    },
    get: <TView extends TaskViewName = "core">(
      project: string,
      key: string,
      view: TView = "core" as TView,
    ) =>
      request<TaskViewFor<TView>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(project)}/work-items/${encodeURIComponent(key)}${queryString({ view })}`,
      ),
    pageForUi: (project: string, filters: Record<string, unknown> = {}) =>
      request<CursorPage<Record<string, unknown>>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(project)}/ui/work-items${queryString(filters)}`,
      ),
    listForUi: (
      project: string,
      filters: Record<string, unknown> = {},
      options: CursorDrainOptions = {},
    ): Promise<Array<Record<string, unknown>>> => {
      const { cursor: initialCursor, ...pageFilters } = filters;
      return drainCursorPages(
        (cursor) =>
          request<CursorPage<Record<string, unknown>>>(
            "GET",
            `/api/v1/projects/${encodeURIComponent(project)}/ui/work-items${queryString({
              ...pageFilters,
              cursor,
            })}`,
          ),
        {
          ...options,
          ...((options.initialCursor ??
          (typeof initialCursor === "string" ? initialCursor : undefined))
            ? {
                initialCursor:
                  options.initialCursor ?? (typeof initialCursor === "string" ? initialCursor : ""),
              }
            : {}),
          entity: "TASK_UI_PAGE",
          errorClass: AyanamiClientError,
        },
      );
    },
    getForUi: (project: string, key: string) =>
      request<Record<string, unknown>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(project)}/ui/work-items/${encodeURIComponent(key)}`,
      ),
    create: (project: string, input: Record<string, unknown>) =>
      request<Record<string, unknown>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(project)}/work-items`,
        input,
      ),
    patch: (project: string, input: Record<string, unknown>) =>
      request<Record<string, unknown>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(project)}/work-items/patch`,
        input,
      ),
    checklist: (project: string, id: string, input: Record<string, unknown>) =>
      request<Record<string, unknown>>(
        "PATCH",
        `/api/v1/projects/${encodeURIComponent(project)}/checklist/${encodeURIComponent(id)}`,
        input,
      ),
    createAsUser: (project: string, input: Record<string, unknown>) =>
      request<Record<string, unknown>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(project)}/ui/work-items`,
        input,
      ),
    patchAsUser: (project: string, input: Record<string, unknown>) =>
      request<Record<string, unknown>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(project)}/ui/work-items/patch`,
        input,
      ),
    checklistAsUser: (project: string, id: string, input: Record<string, unknown>) =>
      request<Record<string, unknown>>(
        "PATCH",
        `/api/v1/projects/${encodeURIComponent(project)}/ui/checklist/${encodeURIComponent(id)}`,
        input,
      ),
  };
}
