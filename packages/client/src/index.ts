export type AyanamiClientOptions = {
  endpoint: string;
  token: string;
  fetchImpl?: typeof fetch;
};

export class AyanamiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;

  constructor(input: { code: string; message: string; status: number; requestId?: string | null }) {
    super(input.message);
    this.name = "AyanamiClientError";
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId ?? null;
  }
}

export type RegisteredProject = {
  id: string;
  code: string;
  name: string;
  description: string;
  lifecycle: string;
  coordinationMode: string;
  sourcePaths: string[];
  databasePath: string;
  version: number;
};

function queryString(values: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

export class AyanamiClient {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: AyanamiClientOptions) {
    this.#endpoint = options.endpoint.replace(/\/$/u, "");
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#endpoint}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload: any = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new AyanamiClientError({
          code: "INVALID_RESPONSE",
          message: `服务返回了非 JSON 响应（HTTP ${response.status}）`,
          status: response.status,
        });
      }
    }
    if (!response.ok) {
      throw new AyanamiClientError({
        code: payload?.error?.code ?? "HTTP_ERROR",
        message: payload?.error?.message ?? `请求失败（HTTP ${response.status}）`,
        status: response.status,
        requestId: payload?.request_id ?? response.headers.get("x-request-id"),
      });
    }
    return payload as T;
  }

  status = () => this.request<Record<string, unknown>>("GET", "/api/v1/system/status");
  overview = () => this.request<Record<string, any>>("GET", "/api/v1/overview");

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

  readonly projects = {
    list: () => this.request<RegisteredProject[]>("GET", "/api/v1/projects"),
    get: (code: string) =>
      this.request<RegisteredProject>("GET", `/api/v1/projects/${encodeURIComponent(code)}`),
    attachPath: (code: string, path: string, primary = true) =>
      this.request<RegisteredProject>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/paths`,
        {
          path,
          primary,
        },
      ),
    create: (input: {
      name: string;
      sourcePath: string | null;
      code?: string;
      description?: string;
      coordinationMode?: "SOLO" | "AUTO" | "MULTI";
      creationReason?: string;
    }) => this.request<RegisteredProject>("POST", "/api/v1/projects", input),
    brief: (code: string, session?: string) =>
      this.request<Record<string, unknown>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/brief${queryString({ session })}`,
      ),
    engineeringMetrics: (code: string, task?: string, refresh = false) =>
      this.request<Record<string, any>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/engineering-metrics${queryString({ task, refresh: refresh || undefined })}`,
      ),
    archive: (code: string) =>
      this.request<RegisteredProject>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/archive`,
      ),
    restore: (code: string) =>
      this.request<RegisteredProject>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/restore`,
      ),
    trash: (code: string) =>
      this.request<RegisteredProject>("POST", `/api/v1/projects/${encodeURIComponent(code)}/trash`),
    objectives: (code: string) =>
      this.request<Array<Record<string, any>>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/objectives`,
      ),
    createObjective: (code: string, input: Record<string, unknown>) =>
      this.request<Record<string, any>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/objectives`,
        input,
      ),
    createObjectiveAsUser: (code: string, input: Record<string, unknown>) =>
      this.request<Record<string, any>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/ui/objectives`,
        input,
      ),
    milestones: (code: string, objective?: string) =>
      this.request<Array<Record<string, any>>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/milestones${queryString({ objective })}`,
      ),
    createMilestone: (code: string, input: Record<string, unknown>) =>
      this.request<Record<string, any>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/milestones`,
        input,
      ),
    createMilestoneAsUser: (code: string, input: Record<string, unknown>) =>
      this.request<Record<string, any>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/ui/milestones`,
        input,
      ),
    agents: (code: string) =>
      this.request<Array<Record<string, any>>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/agents`,
      ),
    records: (code: string) =>
      this.request<Array<Record<string, any>>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/records`,
      ),
    updates: (code: string) =>
      this.request<Array<Record<string, any>>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(code)}/project-updates`,
      ),
    draftUpdate: (code: string, opId: string) =>
      this.request<Record<string, any>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/project-updates/draft`,
        { opId },
      ),
    publishUpdate: (code: string, input: Record<string, unknown>) =>
      this.request<Record<string, any>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(code)}/project-updates`,
        input,
      ),
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

  readonly tasks = {
    list: (project: string, filters: Record<string, unknown> = {}) =>
      this.request<Array<Record<string, unknown>>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(project)}/work-items${queryString(filters)}`,
      ),
    get: (project: string, key: string, view: "core" | "context" | "full" = "core") =>
      this.request<Record<string, unknown>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(project)}/work-items/${encodeURIComponent(key)}${queryString({ view })}`,
      ),
    create: (project: string, input: Record<string, unknown>) =>
      this.request<Record<string, unknown>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(project)}/work-items`,
        input,
      ),
    patch: (project: string, input: Record<string, unknown>) =>
      this.request<Record<string, unknown>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(project)}/work-items/patch`,
        input,
      ),
    checklist: (project: string, id: string, input: Record<string, unknown>) =>
      this.request<Record<string, unknown>>(
        "PATCH",
        `/api/v1/projects/${encodeURIComponent(project)}/checklist/${encodeURIComponent(id)}`,
        input,
      ),
    createAsUser: (project: string, input: Record<string, unknown>) =>
      this.request<Record<string, unknown>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(project)}/ui/work-items`,
        input,
      ),
    patchAsUser: (project: string, input: Record<string, unknown>) =>
      this.request<Record<string, unknown>>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(project)}/ui/work-items/patch`,
        input,
      ),
    checklistAsUser: (project: string, id: string, input: Record<string, unknown>) =>
      this.request<Record<string, unknown>>(
        "PATCH",
        `/api/v1/projects/${encodeURIComponent(project)}/ui/checklist/${encodeURIComponent(id)}`,
        input,
      ),
  };

  progress = (project: string, input: Record<string, unknown>) =>
    this.request<Record<string, unknown>>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(project)}/progress-updates`,
      input,
    );

  record = (project: string, input: Record<string, unknown>) =>
    this.request<Record<string, unknown>>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(project)}/records`,
      input,
    );

  recordAsUser = (project: string, input: Record<string, unknown>) =>
    this.request<Record<string, unknown>>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(project)}/ui/records`,
      input,
    );

  search = (query: string, project?: string, limit = 20) => {
    if (!project)
      return this.request<Record<string, unknown>>(
        "GET",
        `/api/v1/search${queryString({ query, limit })}`,
      );
    return this.request<Record<string, unknown>>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(project)}/search${queryString({ query, limit })}`,
    );
  };

  events = (project: string, since = 0, limit = 50, types: string[] = []) =>
    this.request<Record<string, unknown>>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(project)}/events${queryString({ since, limit, types: types.join(",") })}`,
    );

  doctor = () => this.request<Record<string, unknown>>("GET", "/api/v1/system/status");
}
