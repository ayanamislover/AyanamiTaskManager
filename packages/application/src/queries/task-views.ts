import {
  TaskContextViewSchema,
  TaskCoreViewSchema,
  TaskFullViewSchema,
  type TaskContextView,
  type TaskCoreView,
  type TaskFullView,
  type TaskRelationView,
  type TaskView,
  type TaskViewName,
} from "@ayanami-task/protocol";
import type { TaskViewProjectionRow } from "@ayanami-task/storage-sqlite";

function parseArray(value: string | undefined): unknown[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
}

function taskKey(projectCode: string, localNo: number): string {
  return `${projectCode}-T-${String(localNo).padStart(4, "0")}`;
}

function preview(value: string, maxCodePoints = 240): string {
  const points = Array.from(value);
  return points.length <= maxCodePoints ? value : points.slice(0, maxCodePoints).join("");
}

function core(projectCode: string, row: TaskViewProjectionRow): TaskCoreView {
  return TaskCoreViewSchema.parse({
    key: taskKey(projectCode, row.localNo),
    status: row.status,
    phase: row.phase,
    waitingOn: row.waitingOn,
    progress: Number(row.progress),
    progressSource: row.progressSource,
    version: Number(row.version),
    updatedAt: row.updatedAt,
  });
}

function context(projectCode: string, row: TaskViewProjectionRow): TaskContextView {
  return TaskContextViewSchema.parse({
    ...core(projectCode, row),
    title: row.title ?? "",
    descriptionPreview: preview(row.description ?? ""),
    acceptance: parseArray(row.acceptanceJson).filter(
      (entry): entry is string => typeof entry === "string",
    ),
    checklistSummary: {
      total: Number(row.checklistTotal ?? 0),
      todo: Number(row.checklistTodo ?? 0),
      doing: Number(row.checklistDoing ?? 0),
      done: Number(row.checklistDone ?? 0),
      skipped: Number(row.checklistSkipped ?? 0),
      evidenceRequired: Number(row.checklistEvidenceRequired ?? 0),
      evidenceMissing: Number(row.checklistEvidenceMissing ?? 0),
    },
    assigneeAgentId: row.assigneeAgentId ?? null,
    waitingFor: row.waitingFor ?? null,
    blockedReason: row.blockedReason ?? null,
  });
}

export function projectTaskView(
  projectCode: string,
  row: TaskViewProjectionRow,
  view: "core",
): TaskCoreView;
export function projectTaskView(
  projectCode: string,
  row: TaskViewProjectionRow,
  view: "context",
): TaskContextView;
export function projectTaskView(
  projectCode: string,
  row: TaskViewProjectionRow,
  view: "full",
): TaskFullView;
export function projectTaskView(
  projectCode: string,
  row: TaskViewProjectionRow,
  view: TaskViewName,
): TaskView;
export function projectTaskView(
  projectCode: string,
  row: TaskViewProjectionRow,
  view: TaskViewName,
): TaskView {
  if (view === "core") return core(projectCode, row);
  const contextual = context(projectCode, row);
  if (view === "context") return contextual;
  const checklist = parseArray(row.checklistJson);
  const relations = parseArray(row.relationsJson).map((value) => {
    const relation = value as { type: TaskRelationView["type"]; direction: TaskRelationView["direction"]; localNo: number };
    return {
      type: relation.type,
      direction: relation.direction,
      taskKey: taskKey(projectCode, Number(relation.localNo)),
    };
  });
  return TaskFullViewSchema.parse({
    ...contextual,
    description: row.description ?? "",
    checklist,
    relations,
  });
}
