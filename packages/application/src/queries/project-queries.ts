import { type ProjectionStateView, type ProjectionSummary } from "@ayanami-task/protocol";
import type { ProjectRestoreRequestView, RegisteredProject } from "@ayanami-task/storage-sqlite";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";

export function listProjects(runtime: ApplicationServiceRuntime): RegisteredProject[] {
  return runtime.databases.listProjects();
}

/**
 * 垃圾箱里的项目（ATM-T-0492）。默认列表把它们排除在外，侧栏、总览、项目网格都不该看到；
 * 但恢复入口必须能列出它们，否则「移入垃圾箱」就成了单向操作。
 */
export function listTrashedProjects(
  runtime: ApplicationServiceRuntime,
): Array<RegisteredProject & { restoreRequest: ProjectRestoreRequestView | null }> {
  return runtime.databases
    .listProjects(true)
    .filter((project) => project.lifecycle === "TRASHED")
    .map((project) => ({
      ...project,
      // Agent 等着用户授权的那条请求（ATM-T-0493）；没有就是 null。
      restoreRequest: runtime.databases.pendingProjectRestore(project.id),
    }));
}

export function overview(runtime: ApplicationServiceRuntime) {
  return runtime.databases.overview();
}

export function projectionState(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
): ProjectionStateView {
  return runtime.databases.projectionState(projectCode);
}

export function projectionStates(runtime: ApplicationServiceRuntime): ProjectionStateView[] {
  return runtime.databases.listProjectionStates();
}

export function projectionSummary(runtime: ApplicationServiceRuntime): ProjectionSummary {
  return runtime.databases.projectionSummary();
}

export function listSavedViews(runtime: ApplicationServiceRuntime, projectCode?: string) {
  return runtime.databases.listSavedViews(projectCode);
}

export function listSettings(runtime: ApplicationServiceRuntime) {
  return runtime.databases.listSettings();
}

export function getSetting<T>(runtime: ApplicationServiceRuntime, key: string, fallback?: T) {
  return runtime.databases.getSetting<T>(key, fallback);
}

export function listBackups(runtime: ApplicationServiceRuntime, projectCode?: string) {
  return runtime.databases.listBackups(projectCode);
}

export function listQuickTasks(runtime: ApplicationServiceRuntime, status?: string) {
  return runtime.databases.listQuickTasks(status);
}

export async function doctor(runtime: ApplicationServiceRuntime) {
  return runtime.databases.doctor();
}
