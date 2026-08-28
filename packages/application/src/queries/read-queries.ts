import type { RecordPageFilters, SessionPageFilters } from "@ayanami-task/storage-sqlite";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";

export async function brief(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  sessionId?: string | null,
  maxChars = 1200,
) {
  return (await runtime.repository(projectCode)).brief(sessionId, maxChars);
}

export async function briefSnapshot(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  sessionId?: string | null,
) {
  return (await runtime.repository(projectCode)).briefSnapshot(sessionId);
}

export async function planningContext(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
): Promise<{ objectiveId: string | null; milestoneId: string | null }> {
  const repository = await runtime.repository(projectCode);
  const objective = repository.getActiveObjective();
  const milestone = repository.getActiveMilestone(objective?.id);
  return { objectiveId: objective?.id ?? null, milestoneId: milestone?.id ?? null };
}

export async function listObjectives(runtime: ApplicationServiceRuntime, projectCode: string) {
  return (await runtime.repository(projectCode)).listObjectives();
}

export async function listMilestones(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  objectiveId?: string,
) {
  return (await runtime.repository(projectCode)).listMilestones(objectiveId);
}

export async function listAgentSessions(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  limit = 100,
) {
  return (await runtime.repository(projectCode)).listAgentSessions(limit);
}

export async function agentPage(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  filters: SessionPageFilters = {},
) {
  return (await runtime.repository(projectCode)).listAgentSessionPage(filters);
}

export async function getSession(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  id: string,
) {
  return (await runtime.repository(projectCode)).getSessionView(id);
}

export async function listRecords(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  limit = 100,
) {
  return (await runtime.repository(projectCode)).listRecords(limit);
}

export async function recordPage(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  filters: RecordPageFilters = {},
) {
  return (await runtime.repository(projectCode)).listRecordPage(filters);
}

export async function getRecord(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  reference: string,
) {
  return (await runtime.repository(projectCode)).getRecord(reference);
}

export async function getProgressUpdate(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  id: string,
) {
  return (await runtime.repository(projectCode)).getProgressUpdate(id);
}

export async function listProjectUpdates(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  limit = 50,
) {
  return (await runtime.repository(projectCode)).listProjectUpdates(limit);
}

export async function getProjectUpdate(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  id: string,
) {
  return (await runtime.repository(projectCode)).getProjectUpdate(id);
}

export async function search(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  query: string,
  limit = 20,
  cursor?: string,
) {
  return (await runtime.repository(projectCode)).search(query, limit, cursor);
}

export function globalSearch(
  runtime: ApplicationServiceRuntime,
  query: string,
  limit = 20,
  cursor?: string,
) {
  return runtime.databases.globalSearch(query, limit, cursor);
}

export function globalDelta(runtime: ApplicationServiceRuntime, sinceSequence: number, limit = 50) {
  return runtime.databases.globalDelta(sinceSequence, limit);
}

export async function delta(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  sinceSequence: number,
  limit = 50,
  types: string[] = [],
) {
  return (await runtime.repository(projectCode)).delta(sinceSequence, limit, types);
}

export async function recentWorkItemChanges(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  taskKey: string,
  limit = 6,
) {
  return (await runtime.repository(projectCode)).recentWorkItemChanges(taskKey, limit);
}

export async function checklistConflictSnapshot(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  checklistId: string,
) {
  return (await runtime.repository(projectCode)).checklistConflictSnapshot(checklistId);
}

export async function recentChecklistChanges(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  checklistId: string,
  limit = 6,
) {
  return (await runtime.repository(projectCode)).recentChecklistChanges(checklistId, limit);
}

export async function getOperationTrace(
  runtime: ApplicationServiceRuntime,
  projectCode: string,
  opId: string,
  sessionId?: string | null,
) {
  return (await runtime.repository(projectCode)).getOperationTrace(opId, sessionId);
}
