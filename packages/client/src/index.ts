import type { ProjectionBatchReceipt, SearchPage } from "@ayanami-task/protocol";
import { queryString, requestJson } from "./http.js";
import { createProjectsSurface } from "./surfaces/projects.js";
import { createTasksSurface } from "./surfaces/tasks.js";
import type {
  AgentRecordCreateInput,
  AyanamiClientOptions,
  OverviewResponse,
  RecordCreateReceipt,
  SystemStatus,
  UserRecordCreateInput,
} from "./types.js";

export { drainCursorPages } from "./cursor-drain.js";
export type { CursorDrainOptions, CursorPage } from "./cursor-drain.js";
export { AyanamiClientError } from "./http.js";
export type * from "./types.js";

export class AyanamiClient {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: AyanamiClientOptions) {
    this.#endpoint = options.endpoint.replace(/\/$/u, "");
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requestJson<T>({
      endpoint: this.#endpoint,
      token: this.#token,
      fetchImpl: this.#fetch,
      method,
      path,
      ...(body === undefined ? {} : { body }),
    });
  }

  status = () => this.request<SystemStatus>("GET", "/api/v1/system/status");
  overview = () => this.request<OverviewResponse>("GET", "/api/v1/overview");

  readonly savedViews = {
    list: (project?: string) =>
      this.request<Array<Record<string, any>>>(
        "GET",
        `/api/v1/saved-views${queryString({ project })}`,
      ),
    create: (input: Record<string, unknown>) =>
      this.request<Record<string, any>>("POST", "/api/v1/saved-views", input),
    patch: (id: string, input: Record<string, unknown>) =>
      this.request<Record<string, any>>(
        "PATCH",
        `/api/v1/saved-views/${encodeURIComponent(id)}`,
        input,
      ),
    remove: (id: string, expectedVersion: number) =>
      this.request<Record<string, any>>(
        "DELETE",
        `/api/v1/saved-views/${encodeURIComponent(id)}${queryString({ expectedVersion })}`,
      ),
  };

  readonly settings = {
    list: () => this.request<Array<Record<string, any>>>("GET", "/api/v1/settings"),
    put: (key: string, value: unknown, expectedVersion?: number) =>
      this.request<Record<string, any>>("PUT", `/api/v1/settings/${encodeURIComponent(key)}`, {
        value,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      }),
  };

  readonly projects = createProjectsSurface(this.request.bind(this));

  readonly projections = {
    reconcileAll: () =>
      this.request<ProjectionBatchReceipt>("POST", "/api/v1/system/projections/reconcile"),
  };

  readonly sessions = {
    begin: (input: Record<string, unknown>) =>
      this.request<Record<string, unknown>>("POST", "/api/v1/sessions", input),
    end: (session: string, input: Record<string, unknown>) =>
      this.request<Record<string, unknown>>(
        "POST",
        `/api/v1/sessions/${encodeURIComponent(session)}/close`,
        input,
      ),
    forceClose: (session: string, project: string, releaseClaims = true) =>
      this.request<Record<string, unknown>>(
        "POST",
        `/api/v1/sessions/${encodeURIComponent(session)}/force-close`,
        { project, releaseClaims },
      ),
    refreshGitContext: (session: string, project: string) =>
      this.request<Record<string, unknown>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(session)}/git-context/refresh`,
      ),
  };

  readonly quick = {
    list: (status?: string) =>
      this.request<Array<Record<string, unknown>>>(
        "GET",
        `/api/v1/quick-tasks${queryString({ status })}`,
      ),
    create: (input: Record<string, unknown>) =>
      this.request<Record<string, unknown>>("POST", "/api/v1/quick-tasks", input),
    patch: (id: string, input: Record<string, unknown>) =>
      this.request<Record<string, unknown>>(
        "PATCH",
        `/api/v1/quick-tasks/${encodeURIComponent(id)}`,
        input,
      ),
    promote: (id: string, input: Record<string, unknown>) =>
      this.request<Record<string, unknown>>(
        "POST",
        `/api/v1/quick-tasks/${encodeURIComponent(id)}/promote`,
        input,
      ),
  };

  readonly backups = {
    list: (project?: string) =>
      this.request<Array<Record<string, any>>>("GET", `/api/v1/backups${queryString({ project })}`),
    create: (project?: string) =>
      this.request<Record<string, any>>("POST", "/api/v1/backups", {
        scope: project ? "PROJECT" : "REGISTRY",
        ...(project ? { project } : {}),
      }),
    restore: (id: string) =>
      this.request<Record<string, any>>(
        "POST",
        `/api/v1/backups/${encodeURIComponent(id)}/restore`,
      ),
  };

  readonly data = {
    previewAgentTask: (input: { project: string; content: string; sourceName?: string }) =>
      this.request<Record<string, any>>("POST", "/api/v1/imports/agenttask-md/preview", input),
    applyAgentTask: (input: {
      project: string;
      content: string;
      sourceName?: string;
      expectedSha256?: string;
    }) => this.request<Record<string, any>>("POST", "/api/v1/imports/agenttask-md/apply", input),
    exportProject: (project: string, format: "aytproj" | "json" | "csv" = "aytproj") =>
      this.request<Record<string, any>>(
        "GET",
        `/api/v1/exports/${encodeURIComponent(project)}${queryString({ format })}`,
      ),
  };

  readonly tasks = createTasksSurface(this.request.bind(this));

  progress = (project: string, input: Record<string, unknown>) =>
    this.request<Record<string, unknown>>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(project)}/progress-updates`,
      input,
    );

  record = (project: string, input: AgentRecordCreateInput) =>
    this.request<RecordCreateReceipt>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(project)}/records`,
      input,
    );

  recordAsUser = (project: string, input: UserRecordCreateInput) =>
    this.request<RecordCreateReceipt>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(project)}/ui/records`,
      input,
    );

  search = (query: string, project?: string, limit = 20, cursor?: string) => {
    if (!project) {
      return this.request<SearchPage>(
        "GET",
        `/api/v1/search${queryString({ query, limit, cursor })}`,
      );
    }
    return this.request<SearchPage>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(project)}/search${queryString({ query, limit, cursor })}`,
    );
  };

  events = (project: string, since = 0, limit = 50, types: string[] = []) =>
    this.request<Record<string, unknown>>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(project)}/events${queryString({ since, limit, types: types.join(",") })}`,
    );

  doctor = () => this.request<SystemStatus>("GET", "/api/v1/system/status");
}
