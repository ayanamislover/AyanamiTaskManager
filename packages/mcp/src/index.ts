import { createInterface } from "node:readline";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AyanamiTaskService } from "@ayanami-task/application";

const outputSchema = z.object({}).catchall(z.unknown());
const projectCode = z.string().trim().min(1).max(20);
const taskKey = z.string().trim().min(1).max(40);
const opId = z.string().trim().min(1).max(128);
const sessionId = z.string().trim().min(1).max(128);

function compactJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactJsonSchema);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  if (Array.isArray(source.anyOf) && source.anyOf.length === 2) {
    const types = source.anyOf.map((entry) => (entry as Record<string, unknown>)?.type);
    if (types.every((type) => typeof type === "string") && types.includes("null"))
      return { type: types };
  }
  const omitted = new Set([
    "$schema",
    "default",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minItems",
    "maxItems",
  ]);
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key, entry]) => !omitted.has(key) && entry !== undefined)
      .map(([key, entry]) => [key, compactJsonSchema(entry)]),
  );
}

function installCompactToolList(server: McpServer): void {
  type RegisteredTool = {
    enabled: boolean;
    title?: string;
    description?: string;
    inputSchema?: z.ZodType;
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(registered)
      .filter(([, tool]) => tool.enabled)
      .map(([name, tool]) => ({
        name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: compactJsonSchema(
          tool.inputSchema ? z.toJSONSchema(tool.inputSchema) : { type: "object" },
        ) as any,
        outputSchema: { type: "object" as const },
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool._meta ? { _meta: tool._meta } : {}),
      })),
  }));
}

function plain(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  }
  return { value };
}

function bounded(value: unknown, maxChars: number): Record<string, unknown> {
  const normalized = plain(value);
  for (const [maxString, maxArray] of [
    [180, 10],
    [120, 8],
    [80, 5],
    [48, 3],
  ] as const) {
    const shrink = (entry: unknown): unknown => {
      if (typeof entry === "string") {
        return entry.length > maxString ? `${entry.slice(0, maxString - 1)}…` : entry;
      }
      if (Array.isArray(entry)) return entry.slice(0, maxArray).map(shrink);
      if (entry && typeof entry === "object") {
        return Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).map(([key, child]) => [
            key,
            shrink(child),
          ]),
        );
      }
      return entry;
    };
    const candidate = shrink(normalized) as Record<string, unknown>;
    if (JSON.stringify(candidate).length <= maxChars) return candidate;
  }
  return { truncated: true, code: "RESULT_TOO_LARGE", hint: "缩小 limit、field_mask 或 include" };
}

function wrap(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function result(value: unknown, maxChars = 4000) {
  return wrap(bounded(value, maxChars));
}

// brief 的分节名 -> 载荷字段。truncated/project/seq 是身份字段，任何 include 都保留。
const briefSections = {
  objective: ["objective", "milestone"],
  counts: ["active", "blocked", "waitingUser", "waitingAgent"],
  own: ["own"],
  next: ["next"],
  records: ["records"],
  current: ["currentTask"],
  handoff: ["handoff"],
  progress: ["recentProgress"],
  artifacts: ["artifacts"],
  task: ["task"],
  delta: ["delta"],
} as const;
type BriefSection = keyof typeof briefSections;
const briefSectionNames = Object.keys(briefSections) as [BriefSection, ...BriefSection[]];
const briefAlwaysKeys = ["truncated", "project", "seq"];

// include 为空表示全要；非空时只保留被点名的分节。
function pickBriefSections(
  payload: Record<string, unknown>,
  include: readonly BriefSection[],
): Record<string, unknown> {
  if (include.length === 0) return payload;
  const keep = new Set([...briefAlwaysKeys, ...include.flatMap((name) => briefSections[name])]);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => keep.has(key)));
}

// 装不下时的丢弃顺序，越靠前越先丢。恢复 working set 最需要的
// handoff / currentTask / task 放在最后，宁可只剩它们也不要退化成空回执。
// task 与 delta 只在调用方显式传了 task_key / since_seq 时才存在，
// 属于点名要的内容，因此排在泛泛的 records / progress 之后。
const briefDropOrder: readonly BriefSection[] = [
  "artifacts",
  "own",
  "counts",
  "objective",
  "next",
  "records",
  "progress",
  "delta",
  "task",
  "current",
  "handoff",
];

// bounded() 只截字符串和数组、从不删字段，因此存在删不掉的下限；撞到下限时
// 它会退化成 RESULT_TOO_LARGE 空回执，对调用方毫无用处。这里改为按价值逐级
// 丢分节后重试，保证返回的是「装得下的最大子集」而不是什么都没有。
function fitBrief(
  payload: Record<string, unknown>,
  include: readonly BriefSection[],
  maxChars: number,
): Record<string, unknown> {
  let current = pickBriefSections(payload, include);
  const droppable = briefDropOrder.filter((name) =>
    briefSections[name].some((key) => key in current),
  );
  for (;;) {
    const attempt = bounded(current, maxChars);
    if (attempt.code !== "RESULT_TOO_LARGE") return attempt;
    const victim = droppable.shift();
    if (victim === undefined) return attempt;
    const dropped = new Set<string>(briefSections[victim]);
    current = Object.fromEntries(Object.entries(current).filter(([key]) => !dropped.has(key)));
    current.truncated = true;
  }
}

const workItemCreate = z.object({
  client_ref: z.string().min(1).max(100),
  objective_id: z.string().optional(),
  milestone_id: z.string().nullable().optional(),
  parent_key: z.string().nullable().optional(),
  parent_ref: z.string().nullable().optional(),
  depends_on: z.array(z.string()).max(50).default([]),
  depends_on_refs: z.array(z.string()).max(50).default([]),
  title: z.string().trim().min(1).max(400),
  description: z.string().max(50_000).default(""),
  type: z.enum(["EPIC", "TASK", "SUBTASK", "BUG", "RESEARCH", "REVIEW"]).default("TASK"),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).default("NORMAL"),
  status: z.enum(["BACKLOG", "READY"]).default("BACKLOG"),
  acceptance: z.array(z.string().max(1000)).max(100).default([]),
  checklist: z
    .array(
      z.object({
        title: z.string().min(1).max(400),
        evidence_required: z.boolean().default(false),
        weight: z.number().positive().max(1000).default(1),
      }),
    )
    .max(100)
    .default([]),
  weight: z.number().positive().max(1000).default(1),
  target_date: z.string().nullable().optional(),
  verification_required: z.boolean().default(false),
});

const workItemPatch = z.object({
  task_key: taskKey,
  expected_version: z.number().int().nonnegative(),
  operation: z.enum([
    "claim",
    "start",
    "release",
    "block",
    "wait_user",
    "wait_agent",
    "verify",
    "complete",
    "cancel",
    "reopen",
    "edit",
  ]),
  title: z.string().min(1).max(400).optional(),
  description: z.string().max(50_000).optional(),
  blocked_reason: z.string().min(1).max(2000).optional(),
  waiting_for: z.string().min(1).max(1000).optional(),
  assignee_agent_id: z.string().nullable().optional(),
  target_date: z.string().nullable().optional(),
  parent_key: z.string().nullable().optional(),
  takeover_stale: z.boolean().default(false),
});

function compactTask(item: Record<string, any>, fieldMask: string[] = []) {
  const compact: Record<string, unknown> = {
    key: item.key,
    title: item.title,
    status: item.status,
    priority: item.priority,
    owner: item.assigneeAgentId ?? null,
    progress: item.effectiveProgress,
    version: item.version,
    due: item.targetDate ?? null,
    blocked: item.blockedReason ?? null,
  };
  if (fieldMask.length === 0) return compact;
  return Object.fromEntries(
    fieldMask.filter((field) => field in compact).map((field) => [field, compact[field]]),
  );
}

export function createAyanamiMcpServer(service: AyanamiTaskService): McpServer {
  const server = new McpServer(
    { name: "ayanami-task-manager", version: "1.0.0" },
    {
      instructions:
        "开工调用一次 atm_begin 并直接使用返回的 brief；不要紧接 atm_brief。仅在上下文压缩、长时间离开或明确恢复 working set 时调用 atm_brief。task_list/task_get 按需，结束调用 atm_end。",
    },
  );

  server.registerTool(
    "atm_begin",
    {
      description: "开工或恢复只调用一次；直接使用返回的 brief，task_list/task_get 按需。",
      inputSchema: {
        cwd: z.string().min(1).optional(),
        project_code: projectCode.optional(),
        title: z.string().max(400).optional(),
        mode: z.enum(["auto", "quick", "project"]).default("auto"),
        agent_id: z.string().min(1).max(128),
        display_name: z.string().max(200).optional(),
        client_kind: z.string().max(100).default("generic"),
        thread_id: z.string().nullable().optional(),
        parent_session_id: z.string().nullable().optional(),
        resume: z.boolean().default(false),
        predecessor_session_id: z.string().nullable().optional(),
        role: z.enum(["PRIMARY", "SUBAGENT", "REVIEWER", "OBSERVER"]).default("PRIMARY"),
        signals: z
          .object({
            expected_minutes: z.number().int().nonnegative().optional(),
            subtask_count: z.number().int().nonnegative().optional(),
            multi_session: z.boolean().optional(),
            multi_agent: z.boolean().optional(),
            has_dependencies: z.boolean().optional(),
            needs_evidence: z.boolean().optional(),
            has_target_date: z.boolean().optional(),
          })
          .default({}),
        allow_project_create: z.boolean().default(false),
        creation_reason: z.string().max(500).optional(),
      },
      outputSchema,
    },
    async (input) => {
      const started = await service.begin({
        mode: input.mode,
        agentId: input.agent_id,
        clientKind: input.client_kind,
        role: input.role,
        resume: input.resume,
        allowProjectCreate: input.allow_project_create,
        signals: {
          ...(input.signals.expected_minutes === undefined
            ? {}
            : { expectedMinutes: input.signals.expected_minutes }),
          ...(input.signals.subtask_count === undefined
            ? {}
            : { subtaskCount: input.signals.subtask_count }),
          ...(input.signals.multi_session === undefined
            ? {}
            : { multiSession: input.signals.multi_session }),
          ...(input.signals.multi_agent === undefined
            ? {}
            : { multiAgent: input.signals.multi_agent }),
          ...(input.signals.has_dependencies === undefined
            ? {}
            : { hasDependencies: input.signals.has_dependencies }),
          ...(input.signals.needs_evidence === undefined
            ? {}
            : { needsEvidence: input.signals.needs_evidence }),
          ...(input.signals.has_target_date === undefined
            ? {}
            : { hasTargetDate: input.signals.has_target_date }),
        },
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.project_code === undefined ? {} : { projectCode: input.project_code }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.display_name === undefined ? {} : { displayName: input.display_name }),
        ...(input.thread_id === undefined ? {} : { threadId: input.thread_id }),
        ...(input.parent_session_id === undefined
          ? {}
          : { parentSessionId: input.parent_session_id }),
        ...(input.predecessor_session_id === undefined
          ? {}
          : { predecessorSessionId: input.predecessor_session_id }),
        ...(input.creation_reason === undefined ? {} : { creationReason: input.creation_reason }),
      });
      if (started.scope === "quick") {
        return result(
          {
            scope: "quick",
            quick: started.quick.key,
            status: started.quick.status,
            version: started.quick.version,
          },
          1200,
        );
      }
      const { score, ...brief } = started;
      void score;
      return result(brief, 1200);
    },
  );

  server.registerTool(
    "atm_brief",
    {
      description: "仅在上下文压缩、长时间离开或明确恢复 working set 时重建紧凑上下文。",
      inputSchema: {
        project_code: projectCode,
        session_id: sessionId.optional(),
        task_key: taskKey.optional(),
        since_seq: z.number().int().nonnegative().optional(),
        max_chars: z.number().int().min(300).max(5000).default(1200),
        include: z.array(z.enum(briefSectionNames)).max(briefSectionNames.length).default([]),
      },
      outputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const wanted = (section: BriefSection) =>
        input.include.length === 0 || input.include.includes(section);
      const withTask = input.task_key !== undefined && wanted("task");
      const withDelta = input.since_seq !== undefined && wanted("delta");
      // 附加分节拼在 brief 之上，bounded() 只截字符串和数组、从不删字段，
      // 所以 brief 不能独占全部预算，否则带 task_key 时必然撞上删不掉的下限。
      const extras = (withTask ? 1 : 0) + (withDelta ? 1 : 0);
      const briefBudget =
        extras === 0 ? input.max_chars : Math.max(300, Math.floor(input.max_chars / (extras + 1)));
      const brief = await service.brief(input.project_code, input.session_id, briefBudget);
      const detail = withTask
        ? { task: await service.getWorkItem(input.project_code, input.task_key!, "context") }
        : {};
      const delta = withDelta
        ? { delta: await service.delta(input.project_code, input.since_seq!, 20) }
        : {};
      return wrap(fitBrief({ ...brief, ...detail, ...delta }, input.include, input.max_chars));
    },
  );

  server.registerTool(
    "atm_task_list",
    {
      description: "筛选并分页列出任务。",
      inputSchema: {
        project: projectCode,
        status: z.string().optional(),
        owner: z.string().optional(),
        parent_key: taskKey.optional(),
        milestone_id: z.string().optional(),
        ready_only: z.boolean().default(false),
        query: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(100).default(10),
        cursor: z.string().optional(),
        field_mask: z.array(z.string()).max(20).default([]),
      },
      outputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
      const items = await service.listWorkItems(input.project, {
        readyOnly: input.ready_only,
        limit: input.limit,
        offset,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.owner === undefined ? {} : { assigneeAgentId: input.owner }),
        ...(input.parent_key === undefined ? {} : { parentKey: input.parent_key }),
        ...(input.milestone_id === undefined ? {} : { milestoneId: input.milestone_id }),
        ...(input.query === undefined ? {} : { query: input.query }),
      });
      return result(
        {
          project: input.project.toUpperCase(),
          items: items.map((item) =>
            compactTask(item as unknown as Record<string, any>, input.field_mask),
          ),
          next_cursor: items.length === input.limit ? String(offset + items.length) : null,
        },
        input.limit <= 10 ? 2400 : 12_000,
      );
    },
  );

  server.registerTool(
    "atm_task_get",
    {
      description: "读取单个任务。",
      inputSchema: {
        project: projectCode,
        task_key: taskKey,
        view: z.enum(["core", "context", "full"]).default("core"),
        field_mask: z.array(z.string()).max(30).default([]),
      },
      outputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const item = (await service.getWorkItem(input.project, input.task_key, input.view)) as Record<
        string,
        any
      >;
      if (input.view === "core") return result(compactTask(item, input.field_mask));
      return result(item, input.view === "full" ? 12_000 : 6000);
    },
  );

  server.registerTool(
    "atm_task_create",
    {
      description: "批量创建任务及父子依赖。",
      inputSchema: {
        project: projectCode,
        session: sessionId,
        op_id: opId,
        items: z.array(workItemCreate).min(1).max(50),
      },
      outputSchema,
    },
    async (input) => {
      const context = await service.planningContext(input.project);
      const created = await service.createWorkItems(
        input.project,
        input.session,
        input.op_id,
        input.items.map((item) => {
          const objectiveId = item.objective_id ?? context.objectiveId;
          if (!objectiveId) throw new Error("OBJECTIVE_REQUIRED: 项目尚无活动目标");
          return {
            clientRef: item.client_ref,
            objectiveId,
            dependsOn: item.depends_on,
            dependsOnRefs: item.depends_on_refs,
            title: item.title,
            description: item.description,
            type: item.type,
            priority: item.priority,
            status: item.status,
            acceptance: item.acceptance,
            checklist: item.checklist.map((check) => ({
              title: check.title,
              evidenceRequired: check.evidence_required,
              weight: check.weight,
            })),
            weight: item.weight,
            verificationRequired: item.verification_required,
            ...(item.milestone_id === undefined
              ? context.milestoneId === null
                ? {}
                : { milestoneId: context.milestoneId }
              : { milestoneId: item.milestone_id }),
            ...(item.parent_key === undefined ? {} : { parentKey: item.parent_key }),
            ...(item.parent_ref === undefined ? {} : { parentRef: item.parent_ref }),
            ...(item.target_date === undefined ? {} : { targetDate: item.target_date }),
          };
        }),
      );
      return result({
        ok: true,
        project: input.project.toUpperCase(),
        seq: created.sequence,
        created: created.items.map((item, index) => ({
          client_ref: input.items[index]!.client_ref,
          task_key: item.key,
          version: item.version,
        })),
      });
    },
  );

  server.registerTool(
    "atm_task_patch",
    {
      description: "批量变更任务状态或字段。",
      inputSchema: {
        project: projectCode,
        session: sessionId,
        op_id: opId,
        items: z.array(workItemPatch).min(1).max(50),
      },
      outputSchema,
    },
    async (input) => {
      const patched = await service.patchWorkItems(
        input.project,
        input.session,
        input.op_id,
        input.items.map((item) => ({
          taskKey: item.task_key,
          expectedVersion: item.expected_version,
          operation: item.operation,
          takeoverStale: item.takeover_stale,
          ...(item.title === undefined ? {} : { title: item.title }),
          ...(item.description === undefined ? {} : { description: item.description }),
          ...(item.blocked_reason === undefined ? {} : { blockedReason: item.blocked_reason }),
          ...(item.waiting_for === undefined ? {} : { waitingFor: item.waiting_for }),
          ...(item.assignee_agent_id === undefined
            ? {}
            : { assigneeAgentId: item.assignee_agent_id }),
          ...(item.target_date === undefined ? {} : { targetDate: item.target_date }),
          ...(item.parent_key === undefined ? {} : { parentKey: item.parent_key }),
        })),
      );
      return result({
        ok: true,
        project: input.project.toUpperCase(),
        seq: patched.sequence,
        items: patched.items.map((item) => ({
          key: item.key,
          status: item.status,
          version: item.version,
        })),
      });
    },
  );

  server.registerTool(
    "atm_progress_add",
    {
      description: "写入有意义的任务或项目进度。",
      inputSchema: {
        project: projectCode,
        session: sessionId,
        op_id: opId,
        scope: z.enum(["task", "project"]),
        task_key: taskKey.optional(),
        percent: z.number().min(0).max(100).optional(),
        summary: z.string().min(1).max(500),
        completed: z.array(z.string().max(500)).max(20).default([]),
        next: z.array(z.string().max(500)).max(20).default([]),
        blocker: z.string().max(1000).nullable().optional(),
        health: z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK", "UNKNOWN"]).nullable().optional(),
        evidence: z.array(z.unknown()).max(20).default([]),
      },
      outputSchema,
    },
    async (input) => {
      if (input.scope === "project") {
        const update = await service.addProjectProgress(input.project, input.session, input.op_id, {
          summary: input.summary,
          completed: input.completed,
          next: input.next,
          ...(input.health === undefined ? {} : { health: input.health }),
          ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
        });
        return result({ ok: true, update: update.id, health: update.health, seq: update.seq });
      }
      if (!input.task_key) throw new Error("VALIDATION_ERROR: task scope 要求 task_key");
      const updated = await service.addProgress(input.project, input.session, input.op_id, {
        taskKey: input.task_key,
        summary: input.summary,
        completed: input.completed,
        next: input.next,
        evidence: input.evidence,
        ...(input.percent === undefined ? {} : { percent: input.percent }),
        ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
      });
      return result({
        ok: true,
        task_key: updated.key,
        version: updated.v,
        seq: updated.seq,
        noop: updated.noop ?? false,
      });
    },
  );

  server.registerTool(
    "atm_record",
    {
      description: "保存或取代关键项目记录。",
      inputSchema: {
        project: projectCode,
        session: sessionId,
        op_id: opId,
        kind: z.enum(["DECISION", "CONSTRAINT", "FACT", "RISK", "REFERENCE", "LESSON"]),
        title: z.string().min(1).max(400),
        summary: z.string().min(1).max(300),
        detail: z.string().max(100_000).default(""),
        importance: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).default("NORMAL"),
        scope: z.string().max(100).default("PROJECT"),
        work_item_key: taskKey.nullable().optional(),
        supersedes: z.string().nullable().optional(),
      },
      outputSchema,
    },
    async (input) => {
      const created = await service.createRecord(input.project, input.session, input.op_id, {
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        detail: input.detail,
        importance: input.importance,
        scope: input.scope,
        ...(input.work_item_key === undefined ? {} : { workItemKey: input.work_item_key }),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      });
      return result({ ok: true, record: created.key, version: created.v, seq: created.seq });
    },
  );

  server.registerTool(
    "atm_search",
    {
      description: "搜索项目或全局事实。",
      inputSchema: {
        project: projectCode.optional(),
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(30).default(20),
        cursor: z.string().optional(),
        field_mask: z.array(z.string()).max(20).default([]),
      },
      outputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      result(
        {
          hits: input.project
            ? await service.search(input.project, input.query, input.limit)
            : service.globalSearch(input.query, input.limit),
        },
        6000,
      ),
  );

  server.registerTool(
    "atm_delta",
    {
      description: "读取序列号后的紧凑变化。",
      inputSchema: {
        project: projectCode,
        since_seq: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(100).default(50),
        types: z.array(z.string()).max(50).default([]),
      },
      outputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      result(await service.delta(input.project, input.since_seq, input.limit, input.types), 2400),
  );

  server.registerTool(
    "atm_end",
    {
      description: "结束或退役会话并保存交接。",
      inputSchema: {
        project: projectCode,
        session: sessionId,
        op_id: opId,
        outcome: z.enum(["completed", "paused", "blocked", "cancelled", "error", "retired"]),
        summary: z.string().min(1).max(500),
        next: z.array(z.string().max(500)).max(20).default([]),
        release_claims: z.boolean().default(true),
        retirement_reason: z.string().max(500).nullable().optional(),
      },
      outputSchema,
    },
    async (input) => {
      const ended = await service.end(input.project, input.session, input.op_id, {
        outcome: input.outcome,
        summary: input.summary,
        next: input.next,
        releaseClaims: input.release_claims,
        ...(input.retirement_reason === undefined
          ? {}
          : { retirementReason: input.retirement_reason }),
      });
      return result({ ok: true, session: ended.session, seq: ended.seq, handoffs: ended.handoffs });
    },
  );

  installCompactToolList(server);
  return server;
}

export { result as mcpResult };

export async function handleAyanamiMcpHttp(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  service: AyanamiTaskService,
): Promise<void> {
  const server = createAyanamiMcpServer(service);
  const transport = new StreamableHTTPServerTransport();
  // SDK 1.30's accessor declaration is not assignable under exactOptionalPropertyTypes,
  // although this concrete class implements the same Transport contract at runtime.
  await server.connect(transport as unknown as Transport);
  const cleanup = () => {
    void transport.close();
    void server.close();
  };
  response.once("close", cleanup);
  await transport.handleRequest(request, response, body);
}

export async function runStdioMcpProxy(options: {
  endpoint: string;
  token: string;
  input?: Readable;
  output?: Writable;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const fetchImpl = options.fetchImpl ?? fetch;
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(
        `${JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null })}\n`,
      );
      continue;
    }
    try {
      const response = await fetchImpl(options.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(message),
      });
      if (response.status === 202 || response.status === 204) continue;
      const text = await response.text();
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        for (const data of text
          .split(/\r?\n/u)
          .filter((entry) => entry.startsWith("data:"))
          .map((entry) => entry.slice(5).trim())
          .filter(Boolean)) {
          output.write(`${data}\n`);
        }
      } else if (text.trim()) {
        output.write(`${JSON.stringify(JSON.parse(text))}\n`);
      }
    } catch (error) {
      const id =
        message && typeof message === "object" && "id" in message
          ? ((message as { id?: unknown }).id ?? null)
          : null;
      output.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : "MCP proxy error",
          },
          id,
        })}\n`,
      );
    }
  }
}
