import { createInterface } from "node:readline";
import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { EvidenceInputSchema } from "@ayanami-task/protocol";

const outputSchema = z.object({}).catchall(z.unknown());
const projectCode = z.string().trim().min(1).max(20);
const taskKey = z.string().trim().min(1).max(40);
const opId = z.string().trim().min(1).max(128);
const sessionId = z.string().trim().min(1).max(128);
export const MCP_SURFACE_VERSION = 2;

function compactJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactJsonSchema);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length === 0) return { description: "JSON value" };
  if (
    Array.isArray(source.anyOf) &&
    source.anyOf.length === 2 &&
    source.anyOf.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        !("enum" in entry) &&
        !("const" in entry),
    )
  ) {
    const types = source.anyOf.map((entry) => (entry as Record<string, unknown>)?.type);
    if (types.every((type) => typeof type === "string") && types.includes("null"))
      return { type: types };
  }
  const omitted = new Set([
    "$schema",
    "default",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "minItems",
    "maxItems",
    "additionalProperties",
  ]);
  // Zod 的 default 会让运行时接受字段缺省，但 toJSONSchema 仍把它列进 required。
  // 输出 schema 里既然为了体积省掉 default，就同步从 required 去掉这些键；这既更紧凑，
  // 也让 Agent 看到的必填项与真实运行时一致。
  const properties =
    source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
      ? (source.properties as Record<string, unknown>)
      : null;
  // `signals` are optional begin-time scheduling hints, not a public contract agents need to
  // construct field-by-field. Keep the object type visible while leaving the detailed runtime
  // validation to Zod so higher-value evidence schemas fit inside the fixed tools/list budget.
  if (
    source.type === "object" &&
    properties &&
    ["expected_minutes", "subtask_count", "multi_session", "multi_agent"].every((key) =>
      Object.hasOwn(properties, key),
    )
  ) {
    return { type: "object" };
  }
  const defaulted = new Set(
    properties
      ? Object.entries(properties)
          .filter(([, schema]) =>
            Boolean(
              schema && typeof schema === "object" && !Array.isArray(schema) && "default" in schema,
            ),
          )
          .map(([key]) => key)
      : [],
  );
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key, entry]) => !omitted.has(key) && entry !== undefined)
      .flatMap(([key, entry]) => {
        // Claude 的 tools/list 只有 8 KiB 总预算。保留反馈里会直接造成整次写入失败的
        // 300 字摘要边界；高频 identifier 的长度边界由同一份运行时 Zod 继续执行，
        // 其字符串类型、枚举与 required 仍完整公开。
        if (key === "maxLength" && entry !== 300) return [];
        if (key === "required" && Array.isArray(entry) && defaulted.size > 0) {
          const required = entry.filter((field) => !defaulted.has(String(field)));
          return required.length === 0 ? [] : [[key, compactJsonSchema(required)]];
        }
        return [[key, compactJsonSchema(entry)]];
      }),
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
        ...(["atm_begin", "atm_brief"].includes(name) && tool.description
          ? { description: tool.description }
          : {}),
        inputSchema: compactJsonSchema(
          tool.inputSchema ? z.toJSONSchema(tool.inputSchema) : { type: "object" },
        ) as any,
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
  if (JSON.stringify(normalized).length <= maxChars) return normalized;

  type TruncatedField = {
    path: string;
    original_chars: number;
    returned_chars: number;
  };
  type TruncatedCollection = {
    path: string;
    original_items: number;
    returned_items: number;
  };
  for (const [maxString, maxArray] of [
    [512, 20],
    [180, 10],
    [120, 8],
    [80, 5],
    [48, 3],
  ] as const) {
    const truncatedFields: TruncatedField[] = [];
    const truncatedCollections: TruncatedCollection[] = [];
    const shrink = (entry: unknown, path: string): unknown => {
      if (typeof entry === "string") {
        if (entry.length <= maxString) return entry;
        const returned = `${entry.slice(0, Math.max(0, maxString - 1))}…`;
        truncatedFields.push({
          path,
          original_chars: entry.length,
          returned_chars: returned.length,
        });
        return returned;
      }
      if (Array.isArray(entry)) {
        const returned = entry.slice(0, maxArray);
        if (returned.length < entry.length) {
          truncatedCollections.push({
            path,
            original_items: entry.length,
            returned_items: returned.length,
          });
        }
        return returned.map((child, index) => shrink(child, `${path}[${index}]`));
      }
      if (entry && typeof entry === "object") {
        return Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).map(([key, child]) => {
            const childPath = path ? `${path}.${key}` : key;
            return [key, shrink(child, childPath)];
          }),
        );
      }
      return entry;
    };
    const candidate = shrink(normalized, "") as Record<string, unknown>;
    const annotated: Record<string, unknown> = {
      ...candidate,
      truncated: true,
      ...(truncatedFields.length === 0 ? {} : { truncated_fields: truncatedFields }),
      ...(truncatedCollections.length === 0 ? {} : { truncated_collections: truncatedCollections }),
    };
    if (JSON.stringify(annotated).length <= maxChars) return annotated;
  }
  return {
    truncated: true,
    code: "RESULT_TOO_LARGE",
    hint: "使用该工具的 max_chars、cursor、field_mask、limit 或 include 缩小读取范围",
  };
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

function mutationAck(opId: string, serviceResult: Record<string, unknown>) {
  return {
    op_id: opId,
    ...(serviceResult.sessionRebound === true
      ? {
          session_rebound: true,
          ...(typeof serviceResult.session === "string" ? { session: serviceResult.session } : {}),
        }
      : {}),
  };
}

type FieldCursor = { v: 1; path: Array<string | number>; offset: number };

function encodeFieldCursor(cursor: FieldCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeFieldCursor(token: string): FieldCursor {
  try {
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as FieldCursor;
    if (
      value.v !== 1 ||
      !Array.isArray(value.path) ||
      value.path.some((part) => typeof part !== "string" && !Number.isInteger(part)) ||
      !Number.isInteger(value.offset) ||
      value.offset < 0
    ) {
      throw new Error("invalid shape");
    }
    return value;
  } catch {
    throw new Error("INVALID_CURSOR: continuation cursor 无效或已损坏");
  }
}

function fieldPath(path: Array<string | number>): string {
  return path.reduce<string>(
    (result, part) =>
      typeof part === "number" ? `${result}[${part}]` : result ? `${result}.${part}` : part,
    "",
  );
}

function getAtPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function selectFields(
  value: Record<string, unknown>,
  fieldMask: string[],
): Record<string, unknown> {
  if (fieldMask.length === 0 || fieldMask.includes("*")) return value;
  return Object.fromEntries(
    fieldMask.filter((field) => field in value).map((field) => [field, value[field]]),
  );
}

function continueField(
  source: Record<string, unknown>,
  cursorToken: string,
  maxChars: number,
): Record<string, unknown> {
  const cursor = decodeFieldCursor(cursorToken);
  const field = getAtPath(source, cursor.path);
  if (typeof field !== "string" || cursor.offset > field.length) {
    throw new Error("INVALID_CURSOR: cursor 指向的字段不存在或内容已变化");
  }
  const identity = {
    ...(typeof source.key === "string" ? { key: source.key } : {}),
    field: fieldPath(cursor.path),
    offset: cursor.offset,
    original_chars: field.length,
  };
  let low = 0;
  let high = field.length - cursor.offset;
  let best: Record<string, unknown> | null = null;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const nextOffset = cursor.offset + length;
    const done = nextOffset >= field.length;
    const candidate: Record<string, unknown> = {
      ...identity,
      value: field.slice(cursor.offset, nextOffset),
      returned_chars: length,
      done,
      next_cursor: done ? null : encodeFieldCursor({ v: 1, path: cursor.path, offset: nextOffset }),
    };
    if (JSON.stringify(candidate).length <= maxChars) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  if (!best || best.returned_chars === 0) {
    throw new Error(`RESULT_TOO_LARGE: max_chars=${maxChars} 无法容纳 continuation 回执`);
  }
  return best;
}

function fitFieldRead(
  source: Record<string, unknown>,
  maxChars: number,
  tool: "atm_task_get" | "atm_search",
  cursor?: string,
): Record<string, unknown> {
  if (cursor) return continueField(source, cursor, maxChars);
  if (JSON.stringify(source).length <= maxChars) return source;

  const shrink = (
    value: unknown,
    maxString: number,
    path: Array<string | number>,
    truncated: Array<{
      path: string;
      original_chars: number;
      returned_chars: number;
      continuation: { tool: string; cursor: string };
    }>,
  ): unknown => {
    if (typeof value === "string" && value.length > maxString) {
      const returned = value.slice(0, maxString);
      truncated.push({
        path: fieldPath(path),
        original_chars: value.length,
        returned_chars: returned.length,
        continuation: {
          tool,
          cursor: encodeFieldCursor({ v: 1, path, offset: returned.length }),
        },
      });
      return returned;
    }
    if (Array.isArray(value)) {
      return value.map((entry, index) => shrink(entry, maxString, [...path, index], truncated));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          shrink(entry, maxString, [...path, key], truncated),
        ]),
      );
    }
    return value;
  };

  for (const maxString of [1000, 512, 256, 128, 64, 0]) {
    const truncatedFields: Array<{
      path: string;
      original_chars: number;
      returned_chars: number;
      continuation: { tool: string; cursor: string };
    }> = [];
    const projected = shrink(source, maxString, [], truncatedFields) as Record<string, unknown>;
    const candidate = {
      ...projected,
      truncated: true,
      truncated_fields: truncatedFields,
    };
    if (JSON.stringify(candidate).length <= maxChars) return candidate;
  }

  return bounded(source, maxChars);
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

// atm_brief is a working-set snapshot, not a second atm_task_get. Keep the fields
// needed to resume work, while excluding persistence/session metadata whose object
// overhead cannot be reduced by bounded() and could otherwise evict the requested task.
function compactBriefTask(value: unknown): Record<string, unknown> {
  const task = plain(value);
  const source = task && typeof task === "object" ? (task as Record<string, unknown>) : {};
  const keys = [
    "key",
    "title",
    "type",
    "status",
    "priority",
    "progress",
    "version",
    "description",
    "acceptance",
    "checklist",
    "dependencies",
    "blockedReason",
    "waitingFor",
    "discoveredFrom",
    "discovered",
  ];
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
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

type BeginBriefMode = "none" | "minimal" | "full";

/**
 * `atm_begin` 先在服务端创建 Session，再附带工作摘要。摘要是可降级载荷，Session 身份不是。
 * 通用 bounded() 会递归截断所有字符串，最坏时还会把整个对象换成 RESULT_TOO_LARGE；用于
 * begin 就可能把已经提交的 session/operationId 一并丢掉。这里把不可截断的回执外壳和可裁剪
 * brief 分开计算预算，任何规模下都先保住调用方继续使用 ATM 所必需的门牌号。
 */
function fitBegin(
  payload: Record<string, unknown>,
  mode: BeginBriefMode,
  maxChars: number,
): Record<string, unknown> {
  const atomicOperationId =
    payload.atomicBegin && typeof payload.atomicBegin === "object"
      ? (payload.atomicBegin as Record<string, unknown>).operationId
      : undefined;
  const identity: Record<string, unknown> = {
    scope: payload.scope,
    session: payload.session,
    project: payload.project,
    surface_version: MCP_SURFACE_VERSION,
    ...(typeof atomicOperationId === "string" ? { op_id: atomicOperationId } : {}),
    ...(payload.atomicBegin === undefined ? {} : { atomicBegin: payload.atomicBegin }),
  };
  if (mode === "none") return { ...identity, brief_mode: mode, brief_truncated: false };

  const selected =
    mode === "minimal"
      ? pickBriefSections(payload, ["counts", "next", "current", "handoff"])
      : payload;
  let current = Object.fromEntries(
    Object.entries(selected).filter(
      ([key]) =>
        !["scope", "session", "project", "score", "atomicBegin", "truncated"].includes(key),
    ),
  );
  const droppable = briefDropOrder.filter((name) =>
    briefSections[name].some((key) => key in current),
  );
  const dropped: BriefSection[] = [];
  const serviceTruncated = payload.truncated === true;

  for (;;) {
    const identityChars = JSON.stringify(identity).length;
    const optionalBudget = Math.max(0, maxChars - identityChars - 1);
    const attempt = bounded(current, optionalBudget);
    if (attempt.code !== "RESULT_TOO_LARGE") {
      const briefTruncated = serviceTruncated || dropped.length > 0;
      const candidate: Record<string, unknown> = {
        ...identity,
        ...attempt,
        brief_mode: mode,
        truncated: briefTruncated,
        brief_truncated: briefTruncated,
        ...(dropped.length === 0 ? {} : { omitted_sections: dropped }),
      };
      if (JSON.stringify(candidate).length <= maxChars) return candidate;
      delete candidate.omitted_sections;
      if (JSON.stringify(candidate).length <= maxChars) return candidate;
    }
    const victim = droppable.shift();
    if (victim === undefined) {
      return {
        ...identity,
        brief_mode: mode,
        truncated: true,
        brief_truncated: true,
      };
    }
    dropped.push(victim);
    const keys = new Set<string>(briefSections[victim]);
    current = Object.fromEntries(Object.entries(current).filter(([key]) => !keys.has(key)));
  }
}

const workItemCreate = z
  .object({
    client_ref: z.string().min(1).max(100),
    objective_id: z.string().optional(),
    milestone_id: z.string().nullable().optional(),
    parent_key: z.string().nullable().optional(),
    parent_ref: z.string().nullable().optional(),
    depends_on: z.array(z.string()).max(50).default([]),
    depends_on_refs: z.array(z.string()).max(50).default([]),
    discovered_from: z.string().min(1).max(100).optional(),
    discovered_from_ref: z.string().min(1).max(100).optional(),
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
  })
  .refine((value) => !(value.discovered_from && value.discovered_from_ref), {
    message: "discovered_from 与 discovered_from_ref 只能指定一个",
    path: ["discovered_from_ref"],
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

type TaskProjectionView = "core" | "context" | "full";
type TaskListView = TaskProjectionView | "reconcile";

function summarizeChecklist(value: unknown): Record<string, number> {
  const checklist = Array.isArray(value) ? (value as Array<Record<string, any>>) : [];
  const count = (status: string) => checklist.filter((item) => item.status === status).length;
  return {
    total: checklist.length,
    todo: count("TODO"),
    doing: count("DOING"),
    done: count("DONE"),
    skipped: count("SKIPPED"),
    evidence_required: checklist.filter((item) => item.evidenceRequired === true).length,
    evidence_missing: checklist.filter(
      (item) =>
        item.evidenceRequired === true &&
        item.status !== "SKIPPED" &&
        (!Array.isArray(item.evidence) || item.evidence.length === 0),
    ).length,
  };
}

function taskStateProjection(item: Record<string, any>): Record<string, unknown> {
  const breakdown = plain(item.progressBreakdown);
  return {
    phase: item.phase ?? item.status,
    waiting_on: item.waitingOn ?? null,
    phase_inferred: item.phaseInferred === true,
    reported_progress: item.reportedProgress ?? null,
    progress_source: item.progressSource ?? breakdown.source ?? "NONE",
    progress_breakdown: {
      computed: breakdown.computed ?? item.progress,
      reported: breakdown.reported ?? item.reportedProgress ?? null,
      source: breakdown.source ?? item.progressSource ?? "NONE",
      done_weight: breakdown.doneWeight ?? 0,
      total_weight: breakdown.totalWeight ?? 0,
      done_stages: breakdown.doneStages ?? 0,
      total_stages: breakdown.totalStages ?? 0,
      blocker: breakdown.blocker ?? null,
    },
  };
}

function compactTask(
  item: Record<string, any>,
  fieldMask: string[] = [],
  view: TaskProjectionView = "core",
) {
  const compact: Record<string, unknown> = {
    key: item.key,
    title: item.title,
    type: item.type,
    status: item.status,
    priority: item.priority,
    owner: item.assigneeAgentId ?? null,
    progress: item.progress,
    version: item.version,
    due: item.targetDate ?? null,
    blocked: item.blockedReason ?? null,
    ...taskStateProjection(item),
  };
  if (view !== "core" || fieldMask.includes("checklist")) {
    compact.description = item.description ?? "";
    compact.acceptance = Array.isArray(item.acceptance) ? item.acceptance : [];
    compact.checklist = summarizeChecklist(item.checklist);
    compact.dependencies = Array.isArray(item.dependencies) ? item.dependencies : [];
    compact.discovered_from = item.discoveredFrom ?? null;
    compact.discovered_count = Number(item.discoveredCount ?? 0);
  }
  if (view === "full") {
    compact.checklist_items = Array.isArray(item.checklist) ? item.checklist : [];
    compact.discovered = Array.isArray(item.discovered) ? item.discovered : [];
    compact.execution_session = item.executionSession ?? null;
  }
  if (fieldMask.length === 0 || fieldMask.includes("*")) return compact;
  return Object.fromEntries(
    fieldMask.filter((field) => field in compact).map((field) => [field, compact[field]]),
  );
}

function compactReconciliationItem(item: Record<string, any>): Record<string, unknown> {
  const session = item.session && typeof item.session === "object" ? plain(item.session) : null;
  return {
    task_key: item.taskKey,
    title: item.title,
    status: item.status,
    classification: item.classification,
    reason: item.reason,
    age_seconds: item.ageSeconds,
    session: session
      ? {
          id: session.id,
          agent_id: session.agentId,
          display_name: session.displayName,
          connection_state: session.connectionState,
          last_seen_at: session.lastSeenAt ?? null,
          ended_at: session.endedAt ?? null,
        }
      : null,
    suggested_action: item.suggestedAction,
    evidence_paths: Array.isArray(item.evidencePaths) ? item.evidencePaths : [],
  };
}

type DeltaEvent = {
  seq: number;
  type: string;
  key: string | null;
  summary: string | null;
  actor: string;
  title: string;
  detail: string;
  op_id: string | null;
  at: string;
};

function fitDelta(
  project: string,
  sinceSeq: number,
  requestedLimit: number,
  maxChars: number,
  payload: Record<string, any>,
): Record<string, unknown> {
  const events = (Array.isArray(payload.events) ? payload.events : []).map(
    (event: Record<string, any>): DeltaEvent => ({
      seq: Number(event.seq),
      type: String(event.type ?? ""),
      key: event.key === null || event.key === undefined ? null : String(event.key),
      summary: event.summary === null || event.summary === undefined ? null : String(event.summary),
      actor: String(event.actor ?? ""),
      title: String(event.title ?? ""),
      detail: String(event.detail ?? ""),
      op_id: event.opId === null || event.opId === undefined ? null : String(event.opId),
      at: String(event.at ?? ""),
    }),
  );
  const currentSequence = Number(payload.currentSequence ?? sinceSeq);
  const serviceHasMore = payload.hasMore === true;
  const projectInfo =
    payload.events?.[0]?.project && typeof payload.events[0].project === "object"
      ? {
          code: String(payload.events[0].project.code ?? project).toUpperCase(),
          name: String(payload.events[0].project.name ?? ""),
        }
      : { code: project.toUpperCase() };

  for (let count = events.length; count >= 0; count -= 1) {
    const returned = events.slice(0, count);
    const nextSeq = returned.at(-1)?.seq ?? sinceSeq;
    const budgetTruncated = count < events.length;
    const hasMore = budgetTruncated || serviceHasMore;
    const candidate: Record<string, unknown> = {
      project: projectInfo,
      since_seq: sinceSeq,
      requested_limit: requestedLimit,
      returned_count: returned.length,
      events: returned,
      current_sequence: currentSequence,
      next_seq: nextSeq,
      has_more: hasMore,
      truncated: budgetTruncated,
      ...(budgetTruncated
        ? {
            truncated_collections: [
              {
                path: "events",
                original_items: events.length,
                returned_items: returned.length,
              },
            ],
          }
        : {}),
      ...(hasMore
        ? {
            continuation: {
              tool: "atm_delta",
              arguments: {
                project: project.toUpperCase(),
                since_seq: nextSeq,
                limit: requestedLimit,
                max_chars: maxChars,
              },
            },
          }
        : {}),
    };
    if (count === 0 && events.length > 0) {
      const firstEvent = events[0]!;
      const firstEventChars = JSON.stringify(firstEvent).length;
      candidate.oversized_event = {
        seq: firstEvent.seq,
        chars: firstEventChars,
        suggested_max_chars: Math.min(50_000, Math.max(maxChars + 1, firstEventChars + 800)),
      };
      const continuation = candidate.continuation as Record<string, any> | undefined;
      if (continuation) {
        continuation.arguments.max_chars = (
          candidate.oversized_event as Record<string, number>
        ).suggested_max_chars;
      }
    }
    if (JSON.stringify(candidate).length <= maxChars) return candidate;
  }

  return {
    project: projectInfo,
    since_seq: sinceSeq,
    requested_limit: requestedLimit,
    returned_count: 0,
    events: [],
    current_sequence: currentSequence,
    next_seq: sinceSeq,
    has_more: events.length > 0 || serviceHasMore,
    truncated: events.length > 0,
  };
}

function publicKeyKind(value: string): "WORK_ITEM" | "RECORD" | null {
  if (/-T-\d+$/iu.test(value)) return "WORK_ITEM";
  if (/-[DR]-\d+$/iu.test(value)) return "RECORD";
  return null;
}

function projectFromPublicKey(value: string): string | null {
  const match = /^(.*)-(?:T|D|R)-\d+$/iu.exec(value.trim());
  return match?.[1]?.toUpperCase() ?? null;
}

function compactSearchHit(hit: Record<string, unknown>): Record<string, unknown> {
  return {
    entity_type: hit.entityType,
    entity_key: hit.entityKey,
    title: hit.title,
    snippet: hit.snippet,
    updated_at: hit.updatedAt,
  };
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: record.id,
    key: record.key,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    detail: record.detail,
    importance: record.importance,
    scope: record.scope,
    work_item_key: record.workItemKey ?? null,
    supersedes: record.supersedes ?? null,
    status: record.status,
    topic: record.topic ?? null,
    subject_key: record.subjectKey ?? null,
    related_records: Array.isArray(record.relatedRecords) ? record.relatedRecords : [],
    op_id: record.opId ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function compactOperationTrace(trace: Record<string, any>): Record<string, unknown> {
  return {
    op_id: trace.opId,
    mutations: (Array.isArray(trace.mutations) ? trace.mutations : []).map(
      (mutation: Record<string, unknown>) => ({
        operation: mutation.operation,
        response: mutation.response,
        session_id: mutation.sessionId,
        created_at: mutation.createdAt,
      }),
    ),
    records: (Array.isArray(trace.records) ? trace.records : []).map(
      (record: Record<string, unknown>) => compactRecord(record),
    ),
    progress: (Array.isArray(trace.progress) ? trace.progress : []).map(
      (progress: Record<string, unknown>) => ({
        op_id: progress.opId,
        task_key: progress.taskKey,
        percent: progress.percent,
        summary: progress.summary,
        completed: progress.completed,
        next: progress.next,
        evidence: progress.evidence,
        blocker: progress.blocker,
        session_id: progress.sessionId,
        created_at: progress.createdAt,
      }),
    ),
    project_updates: (Array.isArray(trace.projectUpdates) ? trace.projectUpdates : []).map(
      (update: Record<string, unknown>) => ({
        ...update,
        op_id: update.opId,
      }),
    ),
    events: (Array.isArray(trace.events) ? trace.events : []).map(
      (event: Record<string, unknown>) => ({
        seq: event.seq,
        type: event.type,
        aggregate_type: event.aggregateType,
        aggregate_id: event.aggregateId,
        actor: event.actor,
        session_id: event.sessionId,
        payload: event.payload,
        at: event.at,
        op_id: event.opId,
      }),
    ),
  };
}

function fitTaskPage(
  project: string,
  view: TaskListView,
  offset: number,
  requestedLimit: number,
  maxChars: number,
  items: Array<Record<string, unknown>>,
  sourceHasMore: boolean,
): Record<string, unknown> {
  for (let count = items.length; count >= 0; count -= 1) {
    const returned = items.slice(0, count);
    const budgetTruncated = count < items.length;
    const hasMore = budgetTruncated || sourceHasMore;
    const nextCursor = hasMore ? String(offset + returned.length) : null;
    const candidate: Record<string, unknown> = {
      project: project.toUpperCase(),
      view,
      returned_count: returned.length,
      items: returned,
      next_cursor: nextCursor,
      has_more: hasMore,
      truncated: budgetTruncated,
      ...(budgetTruncated
        ? {
            truncated_collections: [
              {
                path: "items",
                original_items: items.length,
                returned_items: returned.length,
              },
            ],
          }
        : {}),
    };
    if (count === 0 && items.length > 0) {
      const firstItemChars = JSON.stringify(items[0]).length;
      candidate.oversized_item = {
        key: items[0]?.key,
        chars: firstItemChars,
        suggested_max_chars: Math.min(50_000, Math.max(maxChars + 1, firstItemChars + 800)),
        hint: "提高 max_chars，或用 field_mask 缩小列表投影，再以相同 cursor 重试",
      };
    }
    if (JSON.stringify(candidate).length <= maxChars) return candidate;
  }
  return {
    project: project.toUpperCase(),
    view,
    returned_count: 0,
    items: [],
    next_cursor: String(offset),
    has_more: items.length > 0 || sourceHasMore,
    truncated: items.length > 0,
  };
}

function fitReconciliationPage(
  projectCode: string,
  reconciliation: Record<string, any>,
  offset: number,
  maxChars: number,
  items: Array<Record<string, unknown>>,
  sourceHasMore: boolean,
): Record<string, unknown> {
  const project = plain(reconciliation.project);
  for (let count = items.length; count >= 1; count -= 1) {
    const returned = items.slice(0, count);
    const budgetTruncated = count < items.length;
    const hasMore = budgetTruncated || sourceHasMore;
    const candidate: Record<string, unknown> = {
      project: String(project.code ?? projectCode).toUpperCase(),
      project_name: project.name ?? null,
      source_root: project.sourceRoot ?? null,
      view: "reconcile",
      generated_at: reconciliation.generatedAt,
      attention_count: reconciliation.attentionCount,
      counts: reconciliation.counts,
      returned_count: returned.length,
      items: returned,
      next_cursor: hasMore ? String(offset + returned.length) : null,
      has_more: hasMore,
      truncated: budgetTruncated,
    };
    if (JSON.stringify(candidate).length <= maxChars) return candidate;
  }
  const first = items[0];
  if (first) {
    const identityKeys = ["task_key", "classification"];
    const identity = Object.fromEntries(
      identityKeys.filter((key) => key in first).map((key) => [key, first[key]]),
    );
    const hasMore = items.length > 1 || sourceHasMore;
    const omittedFields = Object.keys(first).filter((key) => !identityKeys.includes(key));
    const truncatedItem = {
      project: String(project.code ?? projectCode).toUpperCase(),
      view: "reconcile",
      returned_count: 1,
      items: [identity],
      next_cursor: hasMore ? String(offset + 1) : null,
      has_more: hasMore,
      truncated: true,
      truncation: {
        path: "items[0]",
        retry_cursor: String(offset),
        omitted_fields: omittedFields,
      },
    };
    if (JSON.stringify(truncatedItem).length <= maxChars) return truncatedItem;
  }
  return {
    project: projectCode.toUpperCase(),
    view: "reconcile",
    returned_count: 0,
    items: [],
    next_cursor: items.length > 0 || sourceHasMore ? String(offset) : null,
    has_more: items.length > 0 || sourceHasMore,
    truncated: items.length > 0,
  };
}

export function createAyanamiMcpServer(service: AyanamiTaskService): McpServer {
  const server = new McpServer(
    { name: "ayanami-task-manager", version: "1.0.15" },
    {
      instructions:
        "MCP surface v2。开工调用一次 atm_begin 并直接使用返回的 brief；不要紧接 atm_brief。仅在上下文压缩、长时间离开或明确恢复 working set 时调用 atm_brief。task_list/task_get 按需，结束调用 atm_end。",
    },
  );

  server.registerTool(
    "atm_begin",
    {
      description: "开工；直接使用返回的 brief。",
      inputSchema: {
        op_id: opId.optional(),
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
        brief: z.enum(["none", "minimal", "full"]).default("full"),
        max_chars: z.number().int().min(300).max(5000).default(1200),
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
        ...(input.op_id === undefined ? {} : { operationId: input.op_id }),
        mode: input.mode,
        agentId: input.agent_id,
        clientKind: input.client_kind,
        role: input.role,
        resume: input.resume,
        maxChars: input.max_chars,
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
            surface_version: MCP_SURFACE_VERSION,
            ...(input.op_id === undefined ? {} : { op_id: input.op_id }),
          },
          1200,
        );
      }
      const { score, ...brief } = started;
      void score;
      return wrap(fitBegin(brief, input.brief, input.max_chars));
    },
  );

  server.registerTool(
    "atm_brief",
    {
      description: "仅在上下文压缩、长时间离开或明确恢复 working set 时调用。",
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
        ? {
            task: compactBriefTask(
              await service.getWorkItem(input.project_code, input.task_key!, "context"),
            ),
          }
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
      description: "分页列任务。",
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
        view: z.enum(["core", "context", "full", "reconcile"]).default("core"),
        include_active: z.boolean().default(false),
        field_mask: z.array(z.string()).max(20).default([]),
        max_chars: z.number().int().min(500).max(50_000).default(12_000),
      },
      outputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
      if (input.view === "reconcile") {
        const reconciliation = plain(
          await service.reconcileProject(input.project, { includeActive: input.include_active }),
        );
        const allItems = Array.isArray(reconciliation.items)
          ? (reconciliation.items as Array<Record<string, any>>)
          : [];
        const page = allItems.slice(offset, offset + input.limit);
        const projected = page.map((item) =>
          selectFields(compactReconciliationItem(item), input.field_mask),
        );
        return wrap(
          fitReconciliationPage(
            input.project,
            reconciliation,
            offset,
            input.max_chars,
            projected,
            offset + page.length < allItems.length,
          ),
        );
      }
      const projectionView: TaskProjectionView = input.view;
      const filters = {
        readyOnly: input.ready_only,
        limit: input.limit,
        offset,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.owner === undefined ? {} : { assigneeAgentId: input.owner }),
        ...(input.parent_key === undefined ? {} : { parentKey: input.parent_key }),
        ...(input.milestone_id === undefined ? {} : { milestoneId: input.milestone_id }),
        ...(input.query === undefined ? {} : { query: input.query }),
      };
      const items = await service.listWorkItems(input.project, filters);
      const needsContext =
        input.view !== "core" ||
        input.field_mask.some((field) =>
          [
            "checklist",
            "checklist_items",
            "description",
            "acceptance",
            "dependencies",
            "discovered",
            "execution_session",
          ].includes(field),
        );
      const projectedItems = await Promise.all(
        items.map(async (item) => {
          const source = needsContext
            ? await service.getWorkItem(input.project, item.key, projectionView)
            : item;
          return compactTask(
            source as unknown as Record<string, any>,
            input.field_mask,
            projectionView,
          );
        }),
      );
      const sourceHasMore =
        items.length === input.limit &&
        (
          await service.listWorkItems(input.project, {
            ...filters,
            limit: 1,
            offset: offset + items.length,
          })
        ).length > 0;
      return wrap(
        fitTaskPage(
          input.project,
          projectionView,
          offset,
          input.limit,
          input.max_chars,
          projectedItems,
          sourceHasMore,
        ),
      );
    },
  );

  server.registerTool(
    "atm_task_get",
    {
      description: "读单个任务。",
      inputSchema: {
        project: projectCode,
        task_key: taskKey,
        view: z.enum(["core", "context", "full"]).default("core"),
        field_mask: z.array(z.string()).max(30).default([]),
        cursor: z.string().max(2000).optional(),
        max_chars: z.number().int().min(300).max(50_000).default(12_000),
      },
      outputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const item = (await service.getWorkItem(input.project, input.task_key, input.view)) as Record<
        string,
        any
      >;
      const projected =
        input.view === "core"
          ? compactTask(item, input.field_mask)
          : selectFields({ ...plain(item), ...taskStateProjection(item) }, input.field_mask);
      return wrap(fitFieldRead(projected, input.max_chars, "atm_task_get", input.cursor));
    },
  );

  server.registerTool(
    "atm_task_create",
    {
      description: "批量创建任务与关系。",
      inputSchema: {
        project: projectCode,
        session: sessionId,
        op_id: opId,
        items: z.array(workItemCreate).min(1).max(50),
      },
      outputSchema,
    },
    async (input) => {
      // 只有在确实有条目没自带 objective_id 时才去确保规划根，否则会给一个已经
      // 规划好的项目凭空多建一个目标。
      const needsPlanningRoot = input.items.some((item) => item.objective_id === undefined);
      const context = needsPlanningRoot
        ? await service.ensurePlanningRoot(input.project, input.session)
        : { ...(await service.planningContext(input.project)), objectiveProvisioned: false };
      const created = await service.createWorkItems(
        input.project,
        input.session,
        input.op_id,
        input.items.map((item) => {
          // 走到这里 objectiveId 一定有值：没自带的条目上面已经确保过规划根。
          // 这条保留下来是给类型收窄用的（planningContext 返回 string | null）。
          const objectiveId = item.objective_id ?? context.objectiveId;
          if (!objectiveId) throw new Error("OBJECTIVE_REQUIRED: 项目尚无活动目标");
          return {
            clientRef: item.client_ref,
            objectiveId,
            dependsOn: item.depends_on,
            dependsOnRefs: item.depends_on_refs,
            ...(item.discovered_from === undefined ? {} : { discoveredFrom: item.discovered_from }),
            ...(item.discovered_from_ref === undefined
              ? {}
              : { discoveredFromRef: item.discovered_from_ref }),
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
        ...mutationAck(input.op_id, created as unknown as Record<string, unknown>),
        project: input.project.toUpperCase(),
        seq: created.sequence,
        // 目标是机器补的就要说出来，否则事后没人分得清它是谁定的。
        ...(context.objectiveProvisioned ? { planning_root: "PROVISIONED" } : {}),
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
      description: "批量变更任务。",
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
        ...mutationAck(input.op_id, patched as unknown as Record<string, unknown>),
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
    "atm_checklist",
    {
      // 完成闸门的第一道就是检查项。没有这个工具，只用 MCP 的会话到不了 DONE，
      // 而且从工具列表里看不出缺口在哪——只能一路撞到 checklist incomplete。
      // id 与 expected_version 都取自 atm_task_get 的 context 视图（core 不返回 checklist），
      // expected_version 是检查项自己的版本、新建为 0，不是任务的版本。
      description: "改检查项状态并挂证据。",
      inputSchema: {
        project: projectCode,
        session: sessionId,
        op_id: opId,
        id: z.string().trim(),
        expected_version: z.number().int().nonnegative(),
        status: z.enum(["TODO", "DOING", "DONE", "SKIPPED"]),
        evidence: z.array(EvidenceInputSchema).max(100).optional(),
      },
      outputSchema,
    },
    async (input) => {
      const updated = await service.updateChecklist(input.project, input.session, input.op_id, {
        checklistId: input.id,
        expectedVersion: input.expected_version,
        status: input.status,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      });
      return result({
        ok: true,
        ...mutationAck(input.op_id, updated as unknown as Record<string, unknown>),
        project: input.project.toUpperCase(),
        seq: updated.sequence,
        id: input.id,
        status: updated.checklist.status,
        version: updated.checklist.version,
        evidence: updated.checklist.evidence.length,
        task_version: updated.taskVersion,
      });
    },
  );

  server.registerTool(
    "atm_progress_add",
    {
      description: "写任务或项目进度。",
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
        evidence: z.array(EvidenceInputSchema).max(20).default([]),
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
        return result({
          ok: true,
          ...mutationAck(input.op_id, update as unknown as Record<string, unknown>),
          update: update.id,
          health: update.health,
          seq: update.seq,
        });
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
        ...mutationAck(input.op_id, updated as unknown as Record<string, unknown>),
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
      description: "保存关键记录。",
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
      return result({
        ok: true,
        ...mutationAck(input.op_id, created as unknown as Record<string, unknown>),
        record: created.key,
        version: created.v,
        seq: created.seq,
        related_records: Array.isArray(created.relatedRecords) ? created.relatedRecords : [],
      });
    },
  );

  server.registerTool(
    "atm_search",
    {
      description: "搜索事实。",
      inputSchema: {
        project: projectCode.optional(),
        query: z.string().trim().min(1).max(500).optional(),
        op_id: opId.optional(),
        session: sessionId.optional(),
        limit: z.number().int().min(1).max(30).default(20),
        cursor: z.string().optional(),
        field_mask: z.array(z.string()).max(20).default([]),
        max_chars: z.number().int().min(300).max(50_000).default(6000),
      },
      outputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      if (input.op_id) {
        if (!input.project) throw new Error("PROJECT_REQUIRED: op_id 精确回查要求 project");
        const trace = compactOperationTrace(
          plain(await service.getOperationTrace(input.project, input.op_id, input.session)),
        );
        const source = selectFields(trace, input.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, input.max_chars - 80),
          "atm_search",
          input.cursor,
        );
        return wrap({ exact: true, entity_type: "OPERATION", operation: fitted });
      }
      if (!input.query) throw new Error("VALIDATION_ERROR: query 或 op_id 至少提供一个");
      const kind = publicKeyKind(input.query);
      const exactProject = input.project ?? projectFromPublicKey(input.query) ?? undefined;
      if (kind && exactProject) {
        const entity =
          kind === "WORK_ITEM"
            ? await service.getWorkItem(exactProject, input.query, "full")
            : compactRecord(plain(await service.getRecord(exactProject, input.query)));
        const source = selectFields(plain(entity), input.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, input.max_chars - 80),
          "atm_search",
          input.cursor,
        );
        return wrap({
          exact: true,
          entity_type: kind,
          entity: fitted,
        });
      }

      const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
      const fetchLimit = Math.min(30, offset + input.limit + 1);
      const allHits = input.project
        ? await service.search(input.project, input.query, fetchLimit)
        : service.globalSearch(input.query, fetchLimit);
      const hits = allHits
        .slice(offset, offset + input.limit)
        .map((hit) => selectFields(compactSearchHit(plain(hit)), input.field_mask));
      return result(
        {
          exact: false,
          hits,
          next_cursor: offset + hits.length < allHits.length ? String(offset + hits.length) : null,
        },
        input.max_chars,
      );
    },
  );

  server.registerTool(
    "atm_delta",
    {
      description: "读增量变化。",
      inputSchema: {
        project: projectCode,
        since_seq: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(100).default(50),
        types: z.array(z.string()).max(50).default([]),
        max_chars: z.number().int().min(1000).max(50_000).default(12_000),
      },
      outputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const delta = (await service.delta(
        input.project,
        input.since_seq,
        input.limit,
        input.types,
      )) as Record<string, unknown>;
      return wrap(fitDelta(input.project, input.since_seq, input.limit, input.max_chars, delta));
    },
  );

  server.registerTool(
    "atm_end",
    {
      description: "结束会话并交接。",
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
      return result({
        ok: true,
        ...mutationAck(input.op_id, ended as unknown as Record<string, unknown>),
        session: ended.session,
        seq: ended.seq,
        handoffs: ended.handoffs,
      });
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
