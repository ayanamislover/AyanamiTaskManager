import { type ProjectionStateView, type ProjectionSummary } from "@ayanami-task/protocol";
import type { RegisteredProject } from "@ayanami-task/storage-sqlite";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";

export function listProjects(runtime: ApplicationServiceRuntime): RegisteredProject[] {
  return runtime.databases.listProjects();
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
