export type ProjectTaskSortField = "priority" | "status" | "updatedAt";
export type ProjectTaskSortDirection = "asc" | "desc";
export type ProjectTaskSort = {
  field: ProjectTaskSortField;
  direction: ProjectTaskSortDirection;
};

type ProjectTaskSortTarget = {
  priority?: string | null;
  status?: string | null;
  updatedAt?: string | null;
};

const priorityRank: Record<string, number> = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  CRITICAL: 3,
};

const statusRank: Record<string, number> = {
  BACKLOG: 0,
  READY: 1,
  CLAIMED: 2,
  IN_PROGRESS: 3,
  BLOCKED: 4,
  WAITING_USER: 5,
  WAITING_AGENT: 6,
  VERIFYING: 7,
  DONE: 8,
  CANCELLED: 9,
};

export function toggleProjectTaskSort(
  current: ProjectTaskSort | null,
  field: ProjectTaskSortField,
): ProjectTaskSort {
  if (current?.field !== field) return { field, direction: "desc" };
  return { field, direction: current.direction === "desc" ? "asc" : "desc" };
}

export function sortProjectTasks<T extends ProjectTaskSortTarget>(
  tasks: readonly T[],
  sort: ProjectTaskSort | null,
): T[] {
  if (!sort) return [...tasks];
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const compared = compareTaskField(left.task, right.task, sort.field);
      if (compared === 0) return left.index - right.index;
      return sort.direction === "asc" ? compared : -compared;
    })
    .map(({ task }) => task);
}

function compareTaskField(
  left: ProjectTaskSortTarget,
  right: ProjectTaskSortTarget,
  field: ProjectTaskSortField,
): number {
  if (field === "updatedAt") {
    const leftTime = Date.parse(left.updatedAt ?? "");
    const rightTime = Date.parse(right.updatedAt ?? "");
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
      if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
      return Number.isNaN(leftTime) ? -1 : 1;
    }
    return leftTime - rightTime;
  }
  const ranks = field === "priority" ? priorityRank : statusRank;
  return (ranks[left[field] ?? ""] ?? -1) - (ranks[right[field] ?? ""] ?? -1);
}
