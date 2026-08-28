import type { ProjectionReconcileReceipt, RecordPage, SessionPage } from "@ayanami-task/protocol";
import { drainCursorPages, type CursorDrainOptions } from "../cursor-drain.js";
import { AyanamiClientError, queryString, type ClientRequest } from "../http.js";
import type {
  AgentSession,
  ProjectRecord,
  ReconciliationResult,
  RegisteredProject,
} from "../types.js";

export function createProjectsSurface(request: ClientRequest) {
  const surface = {
    list: () => request<RegisteredProject[]>("GET", "/api/v1/projects"),
    get: (code: string) =>
      request<RegisteredProject>("GET", `/api/v1/projects/${encodeURIComponent(code)}`),
    attachPath: (code: string, path: string, primary = true) =>
      request<RegisteredProject>("POST", `/api/v1/projects/${encodeURIComponent(code)}/paths`, {
        path,
        primary,
      }),
    create: (input: {
      name: string;
      sourcePath: string | null;
      code?: string;
      description?: string;
      coordinationMode?: "SOLO" | "AUTO" | "MULTI";
      creationReason?: string;
    }) => request<RegisteredProject>("POST", "/api/v1/projects", input),
    brief: (code: string, session?: string) =>
      request<Record<string, unknown>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/brief${queryString({ session })}`,
      ),
    engineeringMetrics: (code: string, task?: string, refresh = false) =>
      request<Record<string, any>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/engineering-metrics${queryString({ task, refresh: refresh || undefined })}`,
      ),
    archive: (code: string) =>
      request<RegisteredProject>("POST", `/api/v1/projects/${encodeURIComponent(code)}/archive`),
    restore: (code: string) =>
      request<RegisteredProject>("POST", `/api/v1/projects/${encodeURIComponent(code)}/restore`),
    trash: (code: string) =>
      request<RegisteredProject>("POST", `/api/v1/projects/${encodeURIComponent(code)}/trash`),
    objectives: (code: string) =>
      request<Array<Record<string, any>>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/objectives`,
      ),
    createObjective: (code: string, input: Record<string, unknown>) =>
      request<Record<string, any>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/objectives`,
        input,
      ),
    createObjectiveAsUser: (code: string, input: Record<string, unknown>) =>
      request<Record<string, any>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/ui/objectives`,
        input,
      ),
    milestones: (code: string, objective?: string) =>
      request<Array<Record<string, any>>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/milestones${queryString({ objective })}`,
      ),
    createMilestone: (code: string, input: Record<string, unknown>) =>
      request<Record<string, any>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/milestones`,
        input,
      ),
    createMilestoneAsUser: (code: string, input: Record<string, unknown>) =>
      request<Record<string, any>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/ui/milestones`,
        input,
      ),
    agentPage: (code: string, limit = 100, cursor?: string) =>
      request<SessionPage>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/agents${queryString({ limit, cursor })}`,
      ),
    reconciliation: (code: string, includeActive = false) =>
      request<ReconciliationResult>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/reconciliation${queryString({ include_active: includeActive ? 1 : undefined })}`,
      ),
    reconcileProjection: (code: string) =>
      request<ProjectionReconcileReceipt>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/projection/reconcile`,
      ),
    recordPage: (code: string, limit = 100, cursor?: string) =>
      request<RecordPage>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/records${queryString({ limit, cursor })}`,
      ),
    updates: (code: string) =>
      request<Array<Record<string, any>>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/project-updates`,
      ),
    draftUpdate: (code: string, opId: string) =>
      request<Record<string, any>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/project-updates/draft`,
        { opId },
      ),
    publishUpdate: (code: string, input: Record<string, unknown>) =>
      request<Record<string, any>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/project-updates`,
        input,
      ),
  };

  return {
    ...surface,
    agents: (code: string, options: CursorDrainOptions = {}): Promise<AgentSession[]> =>
      drainCursorPages((cursor) => surface.agentPage(code, 100, cursor), {
        ...options,
        entity: "SESSION_PAGE",
        errorClass: AyanamiClientError,
      }),
    records: (code: string, options: CursorDrainOptions = {}): Promise<ProjectRecord[]> =>
      drainCursorPages((cursor) => surface.recordPage(code, 100, cursor), {
        ...options,
        entity: "RECORD_PAGE",
        errorClass: AyanamiClientError,
      }),
  };
}
