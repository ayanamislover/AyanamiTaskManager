import { createInterface } from "node:readline";
import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  EvidenceInputSchema,
  EvidenceReferenceSchema,
  RECORD_SUMMARY_CODE_POINT_LIMIT,
  RecordSubjectKeySchema,
  RecordSummarySchema,
  RecordTopicSchema,
  ReviewCandidateHashSchema,
  WorkItemPatchInputSchema,
  unicodeCodePointLength,
} from "@ayanami-task/protocol";

const outputSchema = z.object({}).catchall(z.unknown());
const projectCode = z.string().trim().min(1).max(20);
const taskKey = z.string().trim().min(1).max(40);
const opId = z.string().trim().min(1).max(128);
const sessionId = z.string().trim().min(1).max(128);
const recordSummary = RecordSummarySchema.superRefine((value, context) => {
  const actualLength = unicodeCodePointLength(value);
  if (actualLength <= RECORD_SUMMARY_CODE_POINT_LIMIT) return;
  context.addIssue({
    code: "custom",
    message: `INVALID_ARGUMENT ${JSON.stringify({
      actual_length: actualLength,
      limit: RECORD_SUMMARY_CODE_POINT_LIMIT,
      path: "summary",
    })}`,
  });
}).meta({ maxLength: RECORD_SUMMARY_CODE_POINT_LIMIT });
export const MCP_SURFACE_VERSION = 3;
export type AyanamiMcpProfile = "core" | "memory";

const mcpProfileTools: Record<AyanamiMcpProfile, readonly string[]> = {
  core: ["atm_begin", "atm_brief", "atm_task_list", "atm_task_get", "atm_task_create", "atm_end"],
  memory: ["atm_task_patch", "atm_progress_add", "atm_record", "atm_search", "atm_delta"],
};

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
  if (
    Array.isArray(source.anyOf) &&
    source.anyOf.length > 0 &&
    source.anyOf.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).type === "object",
    )
  ) {
    const { anyOf, ...rest } = source;
    return compactJsonSchema({
      ...rest,
      type: "object",
      anyOf: (anyOf as Array<Record<string, unknown>>).map(({ type: _type, ...branch }) => branch),
    });
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
    "pattern",
  ]);
  // Zod 的 default 会让运行时接受字段缺省，但 toJSONSchema 仍把它列进 required。
  // 输出 schema 里既然为了体积省掉 default，就同步从 required 去掉这些键；这既更紧凑，
  // 也让 Agent 看到的必填项与真实运行时一致。
  const properties =
    source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
      ? (source.properties as Record<string, unknown>)
      : null;
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
        if (key === "type" && entry === "string" && (source.enum || source.const !== undefined)) {
          return [];
        }
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

function publicToolJsonSchema(name: string, value: unknown): Record<string, unknown> {
  const schema = compactJsonSchema(value) as Record<string, any>;
  if (name === "atm_task_patch") {
    const item = schema.properties?.items?.items;
    if (item) {
      const evidenceDefinition = item.properties.evidence.items;
      schema.$defs = { e: evidenceDefinition };
      item.properties.evidence.items = { $ref: "#/$defs/e" };
      const checklistItem = item.properties.checklist_items.items;
      checklistItem.properties.evidence.items.anyOf[1] = { $ref: "#/$defs/e" };
      item.properties.checklist_items.minItems = 1;
      item.properties.candidate_hashes = {
        type: "object",
        additionalProperties: { type: "string" },
      };
      item.dependentSchemas = {
        expected_fields: { properties: { operation: { const: "edit" } } },
      };
      item.properties.expected_fields.minProperties = 1;
      item.allOf = [
        {
          if: { properties: { operation: { const: "block" } } },
          then: { required: ["blocked_reason"] },
        },
        {
          if: { properties: { operation: { enum: ["wait_user", "wait_agent"] } } },
          then: { required: ["waiting_for"] },
        },
        {
          if: { properties: { operation: { const: "review_request" } } },
          then: {
            required: [
              "parent_checklist_id",
              "expected_parent_checklist_version",
              "candidate_hashes",
            ],
            propertyNames: {
              enum: [
                "task_key",
                "expected_version",
                "takeover_stale",
                "operation",
                "parent_checklist_id",
                "expected_parent_checklist_version",
                "candidate_hashes",
              ],
            },
          },
        },
        {
          if: { properties: { operation: { const: "review_submit" } } },
          then: {
            required: ["request_key", "verdict", "candidate_hashes", "evidence"],
            propertyNames: {
              enum: [
                "task_key",
                "expected_version",
                "takeover_stale",
                "operation",
                "request_key",
                "verdict",
                "candidate_hashes",
                "evidence",
              ],
            },
          },
        },
        {
          if: { properties: { operation: { const: "checklist_single" } } },
          then: {
            required: ["checklist_items"],
            properties: { checklist_items: { maxItems: 1 } },
            propertyNames: {
              enum: [
                "task_key",
                "expected_version",
                "takeover_stale",
                "operation",
                "checklist_items",
              ],
            },
          },
        },
        {
          if: { properties: { operation: { const: "checklist_batch" } } },
          then: {
            required: ["checklist_items"],
            propertyNames: {
              enum: [
                "task_key",
                "expected_version",
                "takeover_stale",
                "operation",
                "checklist_items",
              ],
            },
          },
        },
        {
          if: { properties: { operation: { const: "verify_and_complete" } } },
          then: {
            propertyNames: {
              enum: ["task_key", "expected_version", "takeover_stale", "operation"],
            },
          },
        },
      ];
    }
    schema.allOf = [
      {
        if: {
          properties: {
            items: {
              contains: {
                properties: {
                  operation: {
                    enum: [
                      "verify_and_complete",
                      "review_request",
                      "review_submit",
                      "checklist_single",
                      "checklist_batch",
                    ],
                  },
                },
              },
            },
          },
        },
        then: { properties: { items: { maxItems: 1 } } },
      },
    ];
  }
  if (name === "atm_progress_add") {
    schema.allOf = [
      {
        if: { properties: { scope: { const: "task" } } },
        then: { required: ["task_key"], not: { required: ["health"] } },
      },
      {
        if: { properties: { scope: { const: "project" } } },
        then: { not: { required: ["percent"] } },
      },
    ];
  }
  if (name === "atm_search") {
    schema.anyOf = [{ required: ["query"] }, { required: ["op_id"] }];
    schema.dependentRequired = { session: ["op_id"] };
  }
  return schema;
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
        inputSchema: publicToolJsonSchema(
          name,
          tool.inputSchema ? z.toJSONSchema(tool.inputSchema) : { type: "object" },
        ) as any,
        ...(tool._meta ? { _meta: tool._meta } : {}),
      })),
  }));
}

function installProjectErrorDetails(server: McpServer, service: AyanamiTaskService): void {
  type Handler = (input: Record<string, unknown>, ...rest: unknown[]) => unknown;
  type RegisteredTool = { handler: Handler };
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  for (const tool of Object.values(registered)) {
    const handler = tool.handler;
    tool.handler = (input, ...rest) => {
      const project =
        typeof input.project === "string"
          ? input.project
          : typeof input.project_code === "string"
            ? input.project_code
            : undefined;
      return withMcpErrorDetails(service, project === undefined ? {} : { project }, async () =>
        handler(input, ...rest),
      );
    };
  }
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
  const reboundSession =
    typeof serviceResult.newSession === "string"
      ? serviceResult.newSession
      : typeof serviceResult.session === "string"
        ? serviceResult.session
        : undefined;
  return {
    op_id: opId,
    ...(serviceResult.sessionRebound === true
      ? {
          session_rebound: true,
          ...(reboundSession === undefined
            ? {}
            : { session: reboundSession, new_session: reboundSession }),
        }
      : {}),
  };
}

type McpErrorContext = {
  project?: string;
  taskKey?: string;
  checklistId?: string;
  expectedVersion?: number;
  expectedVersions?: Record<string, number>;
};

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return "INTERNAL_ERROR";
  const candidate = error.message.split(":", 1)[0]!.trim();
  return /^[A-Z][A-Z0-9_]+$/u.test(candidate) ? candidate : "INTERNAL_ERROR";
}

function normalizedSuggestionText(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/gu, "");
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function projectSuggestionDetails(service: AyanamiTaskService, error: Error) {
  const query = normalizedSuggestionText(
    error.message
      .slice(error.message.indexOf(":") + 1)
      .trim()
      .slice(0, 128),
  );
  if (!query) return { did_you_mean: null, candidates: [] };
  const ranked = service
    .listProjects()
    .filter((project) => project.lifecycle !== "TRASHED")
    .map((project) => {
      const code = normalizedSuggestionText(project.code);
      const name = normalizedSuggestionText(project.name);
      const rawScore = Math.min(editDistance(query, code), editDistance(query, name));
      const prefix = code.startsWith(query) || name.startsWith(query);
      return { project, rawScore, score: rawScore - (prefix ? 0.5 : 0), prefix };
    })
    .sort(
      (left, right) =>
        left.score - right.score || left.project.code.localeCompare(right.project.code),
    )
    .slice(0, 5);
  const first = ranked[0];
  const plausible =
    first !== undefined &&
    (first.prefix || first.rawScore <= Math.max(2, Math.ceil(query.length * 0.34)));
  return {
    did_you_mean: plausible ? first!.project.code : null,
    candidates: ranked.map(({ project }) => ({ code: project.code, name: project.name })),
  };
}

async function versionConflictDetails(
  service: AyanamiTaskService,
  error: Error,
  context: McpErrorContext,
) {
  if (!context.project) return null;
  const detail = error.message.slice(error.message.indexOf(":") + 1).trim();
  const segments = detail.split(":");
  const actual = Number(segments.at(-1));
  if (!Number.isInteger(actual) || actual < 0) return null;
  if (context.checklistId && segments.length === 1) {
    const [current, recentChanges] = await Promise.all([
      service.checklistConflictSnapshot(context.project, context.checklistId),
      service.recentChecklistChanges(context.project, context.checklistId, 6),
    ]);
    return {
      entity: "CHECKLIST",
      key: context.checklistId,
      expected: context.expectedVersion ?? null,
      actual,
      current: {
        id: current.id,
        task_key: current.taskKey,
        task_version: current.taskVersion,
        title: current.title,
        status: current.status,
        evidence_required: current.evidenceRequired,
        evidence_count: current.evidenceCount,
        version: current.version,
        updated_at: current.updatedAt,
      },
      recent_changes: recentChanges.slice(0, 6).map((change) => ({
        seq: change.seq,
        type: change.type,
        key: change.key,
        summary: change.summary,
        op_id: change.opId,
        at: change.at,
      })),
      changes_complete: false,
    };
  }
  const taskKey = (segments.length > 1 ? segments[0] : undefined) ?? context.taskKey;
  if (!taskKey) return null;
  const [current, recentChanges] = await Promise.all([
    service.getWorkItem(context.project, taskKey, "core"),
    service.recentWorkItemChanges(context.project, taskKey, 6),
  ]);
  return {
    entity: "WORK_ITEM",
    key: taskKey,
    expected: context.expectedVersions?.[taskKey] ?? context.expectedVersion ?? null,
    actual,
    current: {
      key: current.key,
      version: current.version,
      status: current.status,
      phase: current.phase,
      title: current.title,
      description: current.description,
      assignee_agent_id: current.assigneeAgentId,
      claimed_by_session_id: current.claimedBySessionId,
      target_date: current.targetDate,
      parent_key: current.parentKey,
      cancel_reason: current.cancelReason,
      duplicate_of: current.duplicateOf,
      superseded_by: current.supersededBy,
      updated_at: current.updatedAt,
    },
    recent_changes: recentChanges.slice(0, 6).map((change) => ({
      seq: change.seq,
      type: change.type,
      key: change.key,
      summary: change.summary,
      op_id: change.opId,
      at: change.at,
    })),
    changes_complete: false,
  };
}

async function withMcpErrorDetails<T>(
  service: AyanamiTaskService,
  context: McpErrorContext,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const code = errorCode(error);
    let details: Record<string, unknown> | null = null;
    try {
      if (code === "PROJECT_NOT_FOUND") details = projectSuggestionDetails(service, error);
      if (code === "VERSION_CONFLICT") {
        details = await versionConflictDetails(service, error, context);
      }
    } catch {
      details = null;
    }
    if (!details) throw error;
    throw new Error(`${error.message} MCP_DETAILS=${JSON.stringify(bounded(details, 6000))}`);
  }
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
const briefAlwaysKeys: readonly string[] = ["truncated", "project", "seq"];
const briefCursorSecret = randomBytes(32);
const BRIEF_CURSOR_TTL_MS = 30 * 60 * 1000;

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

type BriefCursor = {
  v: 1;
  p: string;
  s: string;
  i: number;
  b: number;
  q: string;
  o: number;
  k: string;
  c: string;
  e: number;
};

function briefHash(value: unknown, bytes = 16): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest()
    .subarray(0, bytes)
    .toString("base64url");
}

function briefIncludeMask(include: readonly BriefSection[]): number {
  const selected = include.length === 0 ? briefSectionNames : include;
  return selected.reduce((mask, name) => mask | (1 << briefSectionNames.indexOf(name)), 0);
}

function briefQueryHash(taskKey: string | undefined, sinceSeq: number | undefined): string {
  return briefHash([taskKey ?? null, sinceSeq ?? null], 8);
}

function briefSnapshotHash(payload: Record<string, unknown>): string {
  const sectionKeys = new Set<string>(
    briefSectionNames.flatMap((section) => [...briefSections[section]]),
  );
  return briefHash(
    Object.fromEntries(Object.entries(payload).filter(([key]) => sectionKeys.has(key))),
  );
}

function briefRecordKeysHash(payload: Record<string, unknown>): string {
  const records = Array.isArray(payload.records)
    ? (payload.records as Array<Record<string, unknown>>)
    : [];
  return briefHash(
    records.map((record) => record.key),
    12,
  );
}

function encodeBriefCursor(cursor: BriefCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  const signature = createHmac("sha256", briefCursorSecret)
    .update(payload, "utf8")
    .digest()
    .subarray(0, 16)
    .toString("base64url");
  return `${payload}.${signature}`;
}

function decodeBriefCursor(token: string): BriefCursor {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) throw new Error("shape");
    const expected = createHmac("sha256", briefCursorSecret)
      .update(payload, "utf8")
      .digest()
      .subarray(0, 16);
    const received = Buffer.from(signature, "base64url");
    if (
      received.toString("base64url") !== signature ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      throw new Error("signature");
    }
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as BriefCursor;
    if (
      value.v !== 1 ||
      typeof value.p !== "string" ||
      typeof value.s !== "string" ||
      !Number.isInteger(value.i) ||
      !Number.isInteger(value.b) ||
      typeof value.q !== "string" ||
      !Number.isInteger(value.o) ||
      value.o < 0 ||
      typeof value.k !== "string" ||
      typeof value.c !== "string" ||
      !Number.isInteger(value.e)
    ) {
      throw new Error("shape");
    }
    if (Date.now() > value.e) throw new Error("expired");
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === "expired") {
      throw new Error("INVALID_CURSOR: EXPIRED brief continuation 已过期，请重新读取");
    }
    throw new Error("INVALID_CURSOR: brief continuation 无效或已被篡改");
  }
}

function makeBriefCursor(input: {
  project: string;
  sessionId?: string;
  include: readonly BriefSection[];
  maxChars: number;
  taskKey?: string;
  sinceSeq?: number;
  offset: number;
  payload: Record<string, unknown>;
}): string {
  return encodeBriefCursor({
    v: 1,
    p: input.project.toUpperCase(),
    s: input.sessionId ?? "",
    i: briefIncludeMask(input.include),
    b: input.maxChars,
    q: briefQueryHash(input.taskKey, input.sinceSeq),
    o: input.offset,
    k: briefRecordKeysHash(input.payload),
    c: briefSnapshotHash(input.payload),
    e: Date.now() + BRIEF_CURSOR_TTL_MS,
  });
}

function validateBriefCursorRequest(
  cursor: BriefCursor,
  input: {
    project: string;
    sessionId?: string;
    include: readonly BriefSection[];
    maxChars: number;
    taskKey?: string;
    sinceSeq?: number;
  },
): void {
  if (
    cursor.p !== input.project.toUpperCase() ||
    cursor.s !== (input.sessionId ?? "") ||
    cursor.i !== briefIncludeMask(input.include) ||
    cursor.b !== input.maxChars ||
    cursor.q !== briefQueryHash(input.taskKey, input.sinceSeq)
  ) {
    throw new Error("CONTINUATION_CONFLICT: TARGET_MISMATCH brief continuation 请求身份已变化");
  }
}

function validateBriefCursorSnapshot(cursor: BriefCursor, payload: Record<string, unknown>): void {
  const records = Array.isArray(payload.records) ? payload.records : [];
  if (
    cursor.o > records.length ||
    cursor.k !== briefRecordKeysHash(payload) ||
    cursor.c !== briefSnapshotHash(payload)
  ) {
    throw new Error("CONTINUATION_CONFLICT: SNAPSHOT_CHANGED brief continuation 绑定内容已变化");
  }
}

type BriefFitInput = {
  payload: Record<string, unknown>;
  include: readonly BriefSection[];
  maxChars: number;
  identity?: Record<string, unknown>;
  project: string;
  sessionId?: string;
  taskKey?: string;
  sinceSeq?: number;
  beginMode?: BeginBriefMode;
};

function briefCandidate(input: {
  source: Record<string, unknown>;
  identity: Record<string, unknown>;
  dropped: readonly BriefSection[];
  omittedFields: readonly { section: BriefSection; fields: readonly string[] }[];
  recordCount: number;
  totalRecords: number;
  cursor?: string;
  beginMode?: BeginBriefMode;
}): Record<string, unknown> {
  const droppedKeys = new Set<string>(
    input.dropped.flatMap((section) => [...briefSections[section]]),
  );
  const body = Object.fromEntries(
    Object.entries(input.source)
      .filter(
        ([key]) =>
          !briefAlwaysKeys.includes(key) &&
          !droppedKeys.has(key) &&
          !(key in input.identity) &&
          key !== "score",
      )
      .map(([key, value]) =>
        key === "records" && Array.isArray(value)
          ? [key, value.slice(0, input.recordCount)]
          : [key, value],
      ),
  );
  const omittedRecords = input.recordCount < input.totalRecords;
  const truncated =
    input.dropped.length > 0 ||
    input.omittedFields.length > 0 ||
    omittedRecords ||
    input.source.truncated === true;
  return {
    ...input.identity,
    project: input.source.project,
    seq: input.source.seq,
    ...body,
    truncated,
    ...(input.beginMode === undefined
      ? {}
      : { brief_mode: input.beginMode, brief_truncated: truncated }),
    ...(input.dropped.length === 0 ? {} : { omitted_sections: input.dropped }),
    ...(input.omittedFields.length === 0 ? {} : { omitted_fields: input.omittedFields }),
    ...(omittedRecords
      ? {
          omitted_collections: [
            {
              section: "records",
              total_items: input.totalRecords,
              returned_items: input.recordCount,
              omitted_items: input.totalRecords - input.recordCount,
            },
          ],
          ...(input.cursor === undefined
            ? { continuation_omitted: true }
            : { continuation: { tool: "atm_brief", cursor: input.cursor } }),
        }
      : {}),
  };
}

// brief 不对 Record 或其他分节内部做字符串截断。预算不足时先按分节价值丢弃，
// records 则仅在整条边界分页。这样恢复上下文的 Agent 要么读到完整事实，要么收到
// 可续读的省略回执，不会再把半句话当成全部事实。
function fitWholeBrief(input: BriefFitInput): Record<string, unknown> {
  const frozenSource = pickBriefSections(input.payload, input.include);
  let source = frozenSource;
  const records = Array.isArray(frozenSource.records) ? frozenSource.records : [];
  let recordCount = records.length;
  const dropped: BriefSection[] = [];
  const omittedFields: Array<{ section: BriefSection; fields: readonly string[] }> = [];
  const actions = briefDropOrder.filter((section) =>
    briefSections[section].some((key) => key in source),
  );
  const identity = input.identity ?? {};

  for (;;) {
    const cursor =
      recordCount < records.length
        ? makeBriefCursor({
            project: input.project,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            include: input.include,
            maxChars: input.maxChars,
            ...(input.taskKey === undefined ? {} : { taskKey: input.taskKey }),
            ...(input.sinceSeq === undefined ? {} : { sinceSeq: input.sinceSeq }),
            offset: recordCount,
            payload: frozenSource,
          })
        : undefined;
    const candidate = briefCandidate({
      source,
      identity,
      dropped,
      omittedFields,
      recordCount,
      totalRecords: records.length,
      ...(cursor === undefined ? {} : { cursor }),
      ...(input.beginMode === undefined ? {} : { beginMode: input.beginMode }),
    });
    if (JSON.stringify(candidate).length <= input.maxChars) return candidate;

    const victim = actions.shift();
    if (victim !== undefined) {
      if (victim === "records") {
        if (recordCount > 0) {
          recordCount -= 1;
          actions.unshift("records");
        }
        continue;
      }
      if (victim === "task" && source.task && typeof source.task === "object") {
        const task = source.task as Record<string, unknown>;
        const essentialKeys = [
          "key",
          "title",
          "type",
          "status",
          "priority",
          "progress",
          "version",
          "blockedReason",
          "waitingFor",
          "dependencies",
        ];
        const compact = Object.fromEntries(
          essentialKeys.filter((key) => task[key] !== undefined).map((key) => [key, task[key]]),
        );
        const omitted = Object.keys(task).filter((key) => !(key in compact));
        if (omitted.length > 0) {
          source = { ...source, task: compact };
          omittedFields.push({ section: "task", fields: omitted });
          actions.unshift("task");
          continue;
        }
      }
      dropped.push(victim);
      continue;
    }
    if (recordCount > 0) {
      recordCount -= 1;
      continue;
    }

    // 极窄预算可能连带 HMAC 的游标都放不下。身份回执仍逐字保留，不伪造一个
    // 超预算或无法校验的 cursor；调用方可以扩大预算后重新发起首页。
    return briefCandidate({
      source,
      identity,
      dropped,
      omittedFields,
      recordCount: 0,
      totalRecords: records.length,
      ...(input.beginMode === undefined ? {} : { beginMode: input.beginMode }),
    });
  }
}

function continueWholeBrief(
  cursor: BriefCursor,
  input: Omit<BriefFitInput, "identity" | "beginMode">,
): Record<string, unknown> {
  const source = pickBriefSections(input.payload, input.include);
  validateBriefCursorSnapshot(cursor, source);
  const records = Array.isArray(source.records) ? source.records : [];
  let returned = records.length - cursor.o;
  for (;;) {
    const nextOffset = cursor.o + returned;
    const nextCursor =
      nextOffset < records.length
        ? makeBriefCursor({
            project: input.project,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            include: input.include,
            maxChars: input.maxChars,
            ...(input.taskKey === undefined ? {} : { taskKey: input.taskKey }),
            ...(input.sinceSeq === undefined ? {} : { sinceSeq: input.sinceSeq }),
            offset: nextOffset,
            payload: source,
          })
        : undefined;
    const candidate: Record<string, unknown> = {
      project: source.project,
      seq: source.seq,
      ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
      records: records.slice(cursor.o, nextOffset),
      offset: cursor.o,
      returned_items: returned,
      total_items: records.length,
      truncated: nextCursor !== undefined,
      ...(nextCursor === undefined
        ? {}
        : { continuation: { tool: "atm_brief", cursor: nextCursor } }),
    };
    if (JSON.stringify(candidate).length <= input.maxChars) return candidate;
    if (returned > 0) {
      returned -= 1;
      continue;
    }
    throw new Error(
      `RESULT_TOO_LARGE: max_chars=${input.maxChars} 无法容纳一条完整 Record continuation`,
    );
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
  return fitWholeBrief({
    payload: selected,
    include: [],
    maxChars,
    identity,
    project: String(payload.project),
    ...(typeof payload.session === "string" ? { sessionId: payload.session } : {}),
    beginMode: mode,
  });
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
        z
          .object({
            title: z.string().min(1).max(400),
            evidence_required: z.boolean().default(false),
            weight: z.number().positive().max(1000).default(1),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    weight: z.number().positive().max(1000).default(1),
    target_date: z.string().nullable().optional(),
    verification_required: z.boolean().default(false),
    assignee_agent_id: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .strict()
  .refine((value) => !(value.discovered_from && value.discovered_from_ref), {
    message: "discovered_from 与 discovered_from_ref 只能指定一个",
    path: ["discovered_from_ref"],
  });

const workItemExpectedFields = z
  .object({
    title: z.string().trim().min(1).max(400).optional(),
    description: z.string().max(50_000).optional(),
    target_date: z.string().nullable().optional(),
    parent_key: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "expected_fields 至少包含一个字段");

const reviewPatchCommon = {
  task_key: taskKey,
  expected_version: z.number().int().nonnegative(),
  takeover_stale: z.literal(false).default(false),
};
const reviewCandidateHashMap = z
  .record(ReviewCandidateHashSchema.shape.name, ReviewCandidateHashSchema.shape.value)
  .superRefine((hashes, context) => {
    const count = Object.keys(hashes).length;
    if (count < 1 || count > 20) {
      context.addIssue({
        code: "custom",
        message: "candidate_hashes 需要 1 到 20 项",
      });
    }
  });
const reviewRequestPatchInput = z
  .object({
    ...reviewPatchCommon,
    operation: z.literal("review_request"),
    parent_checklist_id: z.string().trim().min(1).max(128),
    expected_parent_checklist_version: z.number().int().nonnegative(),
    candidate_hashes: reviewCandidateHashMap,
  })
  .strict();
const reviewSubmitPatchInput = z
  .object({
    ...reviewPatchCommon,
    operation: z.literal("review_submit"),
    request_key: z.string().trim().min(1).max(128),
    verdict: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
    candidate_hashes: reviewCandidateHashMap,
    evidence: z.array(EvidenceReferenceSchema).min(1).max(100),
  })
  .strict();

const checklistStatus = z.enum(["TODO", "DOING", "DONE", "SKIPPED"]);
const checklistBatchItem = z
  .object({
    id: z.string().trim().min(1),
    status: checklistStatus,
    evidence: z.array(EvidenceInputSchema).max(100).optional(),
  })
  .strict();
const checklistSinglePatchInput = z
  .object({
    ...reviewPatchCommon,
    operation: z.literal("checklist_single"),
    checklist_items: z.array(checklistBatchItem).length(1),
  })
  .strict();
const checklistBatchPatchInput = z
  .object({
    ...reviewPatchCommon,
    operation: z.literal("checklist_batch"),
    checklist_items: z.array(checklistBatchItem).min(1).max(100),
  })
  .strict();

function coreWorkItemPatch(item: Record<string, any>): Record<string, unknown> {
  const expectedFields = item.expected_fields
    ? {
        ...(item.expected_fields.title === undefined ? {} : { title: item.expected_fields.title }),
        ...(item.expected_fields.description === undefined
          ? {}
          : { description: item.expected_fields.description }),
        ...(item.expected_fields.target_date === undefined
          ? {}
          : { targetDate: item.expected_fields.target_date }),
        ...(item.expected_fields.parent_key === undefined
          ? {}
          : { parentKey: item.expected_fields.parent_key }),
      }
    : undefined;
  return {
    taskKey: item.task_key,
    expectedVersion: item.expected_version,
    operation: item.operation,
    takeoverStale: item.takeover_stale,
    ...(expectedFields === undefined ? {} : { expectedFields }),
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.blocked_reason === undefined ? {} : { blockedReason: item.blocked_reason }),
    ...(item.waiting_for === undefined ? {} : { waitingFor: item.waiting_for }),
    ...(item.cancel_reason === undefined ? {} : { cancelReason: item.cancel_reason }),
    ...(item.duplicate_of === undefined ? {} : { duplicateOf: item.duplicate_of }),
    ...(item.superseded_by === undefined ? {} : { supersededBy: item.superseded_by }),
    ...(item.assignee_agent_id === undefined ? {} : { assigneeAgentId: item.assignee_agent_id }),
    ...(item.target_date === undefined ? {} : { targetDate: item.target_date }),
    ...(item.parent_key === undefined ? {} : { parentKey: item.parent_key }),
  };
}

const workItemPatch = z
  .object({
    task_key: taskKey,
    expected_version: z.number().int().nonnegative(),
    expected_fields: workItemExpectedFields.optional(),
    operation: z.enum([
      "claim",
      "start",
      "release",
      "block",
      "wait_user",
      "wait_agent",
      "verify",
      "complete",
      "verify_and_complete",
      "review_request",
      "review_submit",
      "checklist_single",
      "checklist_batch",
      "cancel",
      "reopen",
      "edit",
    ]),
    title: z.string().min(1).max(400).optional(),
    description: z.string().max(50_000).optional(),
    blocked_reason: z.string().min(1).max(2000).optional(),
    waiting_for: z.string().min(1).max(1000).optional(),
    cancel_reason: z.string().trim().min(1).max(2000).optional(),
    duplicate_of: z.string().trim().min(1).max(100).nullable().optional(),
    superseded_by: z.string().trim().min(1).max(100).nullable().optional(),
    assignee_agent_id: z.string().trim().min(1).max(128).nullable().optional(),
    target_date: z.string().nullable().optional(),
    parent_key: z.string().nullable().optional(),
    takeover_stale: z.boolean().default(false),
    parent_checklist_id: z.string().trim().min(1).max(128).optional(),
    expected_parent_checklist_version: z.number().int().nonnegative().optional(),
    request_key: z.string().trim().min(1).max(128).optional(),
    candidate_hashes: reviewCandidateHashMap.optional(),
    verdict: z.enum(["APPROVED", "CHANGES_REQUESTED"]).optional(),
    evidence: z.array(EvidenceReferenceSchema).min(1).max(100).optional(),
    checklist_items: z.array(checklistBatchItem).min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.operation === "review_request" ||
      value.operation === "review_submit" ||
      value.operation === "checklist_single" ||
      value.operation === "checklist_batch"
    ) {
      const parser =
        value.operation === "review_request"
          ? reviewRequestPatchInput
          : value.operation === "review_submit"
            ? reviewSubmitPatchInput
            : value.operation === "checklist_single"
              ? checklistSinglePatchInput
              : checklistBatchPatchInput;
      const parsed = parser.safeParse(value);
      if (parsed.success) return;
      for (const issue of parsed.error.issues) {
        if (issue.code === "unrecognized_keys") {
          for (const key of issue.keys) {
            context.addIssue({
              code: "custom",
              path: [key],
              message: `${value.operation} 不接受 ${key}`,
            });
          }
          continue;
        }
        context.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
      return;
    }
    if (value.operation === "verify_and_complete") {
      const allowed = new Set(["task_key", "expected_version", "operation", "takeover_stale"]);
      for (const [field, fieldValue] of Object.entries(value)) {
        if (!allowed.has(field) && fieldValue !== undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `verify_and_complete 不接受 ${field}`,
          });
        }
      }
      return;
    }
    const parsed = WorkItemPatchInputSchema.safeParse(coreWorkItemPatch(value));
    if (parsed.success) return;
    const pathNames: Record<string, string> = {
      taskKey: "task_key",
      expectedVersion: "expected_version",
      expectedFields: "expected_fields",
      targetDate: "target_date",
      parentKey: "parent_key",
      blockedReason: "blocked_reason",
      waitingFor: "waiting_for",
      cancelReason: "cancel_reason",
      duplicateOf: "duplicate_of",
      supersededBy: "superseded_by",
      assigneeAgentId: "assignee_agent_id",
      takeoverStale: "takeover_stale",
    };
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: "custom",
        path: issue.path.map((part) =>
          typeof part === "string" ? (pathNames[part] ?? part) : part,
        ),
        message: issue.message,
      });
    }
  });

const taskPatchToolInput = z
  .object({
    project: projectCode,
    session: sessionId,
    op_id: opId,
    items: z.array(workItemPatch).min(1).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    const composite = value.items.filter((item) =>
      [
        "verify_and_complete",
        "review_request",
        "review_submit",
        "checklist_single",
        "checklist_batch",
      ].includes(item.operation),
    );
    if (composite.length > 0 && value.items.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: `${composite[0]!.operation} 必须作为唯一 item`,
      });
    }
  });

const progressCompleted = z.union([
  z.string().max(500),
  z
    .object({
      text: z.string().trim().min(1).max(500),
      work_item_key: taskKey.optional(),
    })
    .strict(),
]);
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

export function createAyanamiMcpServer(
  service: AyanamiTaskService,
  options: { profile?: AyanamiMcpProfile } = {},
): McpServer {
  const profile = options.profile ?? "core";
  const server = new McpServer(
    { name: "ayanami-task-manager", version: "1.0.15" },
    {
      instructions:
        profile === "core"
          ? "MCP surface v3 · core profile。开工调用一次 atm_begin 并直接使用返回的 brief；不要紧接 atm_brief。仅在上下文压缩、长时间离开或明确恢复 working set 时调用 atm_brief。task_list/task_get 按需，结束调用 atm_end。"
          : "MCP surface v3 · memory profile。Session 由 core profile 建立；本 profile 负责进度、长期记录、搜索与增量读取。",
    },
  );

  server.registerTool(
    "atm_begin",
    {
      description: "直接使用返回的 brief",
      inputSchema: z
        .object({
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
            .strict()
            .default({}),
          allow_project_create: z.boolean().default(false),
          creation_reason: z.string().max(500).optional(),
        })
        .strict(),
      outputSchema,
    },
    async (input) => {
      const started = await withMcpErrorDetails(
        service,
        input.project_code === undefined ? {} : { project: input.project_code },
        () =>
          service.begin({
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
            ...(input.creation_reason === undefined
              ? {}
              : { creationReason: input.creation_reason }),
          }),
      );
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
      const snapshot = await service.briefSnapshot(
        String(started.project),
        String(started.session),
      );
      const { score, truncated: _legacyTruncated, ...beginIdentity } = started;
      void score;
      void _legacyTruncated;
      return wrap(fitBegin({ ...beginIdentity, ...snapshot }, input.brief, input.max_chars));
    },
  );

  server.registerTool(
    "atm_brief",
    {
      description: "仅在上下文压缩、长时间离开或明确恢复 working set",
      inputSchema: z
        .object({
          project_code: projectCode,
          session_id: sessionId.optional(),
          task_key: taskKey.optional(),
          since_seq: z.number().int().nonnegative().optional(),
          cursor: z.string().min(1).optional(),
          max_chars: z.number().int().min(300).max(5000).default(1200),
          include: z.array(z.enum(briefSectionNames)).max(briefSectionNames.length).default([]),
        })
        .strict(),
      outputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const decodedCursor = input.cursor === undefined ? null : decodeBriefCursor(input.cursor);
      if (decodedCursor) {
        validateBriefCursorRequest(decodedCursor, {
          project: input.project_code,
          ...(input.session_id === undefined ? {} : { sessionId: input.session_id }),
          include: input.include,
          maxChars: input.max_chars,
          ...(input.task_key === undefined ? {} : { taskKey: input.task_key }),
          ...(input.since_seq === undefined ? {} : { sinceSeq: input.since_seq }),
        });
      }
      const wanted = (section: BriefSection) =>
        input.include.length === 0 || input.include.includes(section);
      const withTask = input.task_key !== undefined && wanted("task");
      const withDelta = input.since_seq !== undefined && wanted("delta");
      const brief = await service.briefSnapshot(input.project_code, input.session_id);
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
      const payload = { ...brief, ...detail, ...delta };
      const fitInput = {
        payload,
        include: input.include,
        maxChars: input.max_chars,
        project: input.project_code,
        ...(input.session_id === undefined ? {} : { sessionId: input.session_id }),
        ...(input.task_key === undefined ? {} : { taskKey: input.task_key }),
        ...(input.since_seq === undefined ? {} : { sinceSeq: input.since_seq }),
      };
      return wrap(
        decodedCursor
          ? continueWholeBrief(decodedCursor, fitInput)
          : fitWholeBrief({
              ...fitInput,
              identity: input.session_id === undefined ? {} : { session_id: input.session_id },
            }),
      );
    },
  );

  server.registerTool(
    "atm_task_list",
    {
      description: "分页列任务。",
      inputSchema: z
        .object({
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
        })
        .strict(),
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
      inputSchema: z
        .object({
          project: projectCode,
          task_key: taskKey,
          view: z.enum(["core", "context", "full"]).default("core"),
          field_mask: z.array(z.string()).max(30).default([]),
          cursor: z.string().max(2000).optional(),
          max_chars: z.number().int().min(300).max(50_000).default(12_000),
        })
        .strict(),
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
      inputSchema: z
        .object({
          project: projectCode,
          session: sessionId,
          op_id: opId,
          items: z.array(workItemCreate).min(1).max(50),
        })
        .strict(),
      outputSchema,
    },
    async (input) => {
      const needsPlanningRoot = input.items.some((item) => item.objective_id === undefined);
      const context = needsPlanningRoot
        ? await service.ensurePlanningRoot(input.project, input.session)
        : { ...(await service.planningContext(input.project)), objectiveProvisioned: false };
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
            ...(item.assignee_agent_id === undefined
              ? {}
              : { assigneeAgentId: item.assignee_agent_id }),
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
          ...(input.items[index]!.assignee_agent_id === undefined
            ? {}
            : { assignee_agent_id: input.items[index]!.assignee_agent_id }),
        })),
      });
    },
  );

  server.registerTool(
    "atm_task_patch",
    {
      description: "批量变更任务。",
      inputSchema: taskPatchToolInput,
      outputSchema,
    },
    async (input) => {
      const composite = input.items.filter((item) =>
        [
          "verify_and_complete",
          "review_request",
          "review_submit",
          "checklist_single",
          "checklist_batch",
        ].includes(item.operation),
      );
      if (composite.length > 0) {
        if (input.items.length !== 1) {
          throw new Error(
            `VALIDATION_ERROR: ${composite[0]!.operation} 必须作为 atm_task_patch 的唯一 item`,
          );
        }
      }
      if (composite[0]?.operation === "review_request") {
        const item = reviewRequestPatchInput.parse(composite[0]);
        const created = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            taskKey: item.task_key,
            checklistId: item.parent_checklist_id,
            expectedVersion: item.expected_parent_checklist_version,
            expectedVersions: { [item.task_key]: item.expected_version },
          },
          () =>
            service.createReviewRequest(input.project, input.session, input.op_id, {
              reviewTaskKey: item.task_key,
              expectedReviewTaskVersion: item.expected_version,
              parentChecklistId: item.parent_checklist_id,
              expectedParentChecklistVersion: item.expected_parent_checklist_version,
              expectedCandidateHashes: Object.entries(item.candidate_hashes).map(
                ([name, value]) => ({ name, value }),
              ),
            }),
        );
        return result({
          ok: true,
          ...mutationAck(input.op_id, created as unknown as Record<string, unknown>),
          project: input.project.toUpperCase(),
          seq: created.sequence,
          review_request: {
            request_key: created.request.key,
            review_task_key: created.request.reviewTaskKey,
            parent_task_key: created.request.parentTaskKey,
            parent_checklist_id: created.request.parentChecklistId,
            parent_checklist_version: created.request.parentChecklistVersion,
            expected_candidate_hashes: created.request.expectedCandidateHashes,
            created_by_agent_id: created.request.createdByAgentId,
            created_by_session_id: created.request.createdBySessionId,
            submission: created.request.submission,
          },
        });
      }
      if (composite[0]?.operation === "review_submit") {
        const item = reviewSubmitPatchInput.parse(composite[0]);
        const request = await service.getReviewRequest(input.project, item.request_key);
        if (request.reviewTaskKey !== item.task_key) {
          throw new Error(`REVIEW_BINDING_MISMATCH: ${item.task_key}`);
        }
        const submitted = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            taskKey: item.task_key,
            checklistId: request.parentChecklistId,
            expectedVersion: request.parentChecklistVersion,
            expectedVersions: { [item.task_key]: item.expected_version },
          },
          () =>
            service.submitReview(input.project, input.session, input.op_id, {
              requestKey: item.request_key,
              expectedReviewTaskVersion: item.expected_version,
              verdict: item.verdict,
              reviewedHashes: Object.entries(item.candidate_hashes).map(([name, value]) => ({
                name,
                value,
              })),
              evidence: item.evidence,
            }),
        );
        return result({
          ok: true,
          ...mutationAck(input.op_id, submitted as unknown as Record<string, unknown>),
          project: input.project.toUpperCase(),
          seq: submitted.sequence,
          review_submission: {
            request_key: submitted.requestKey,
            submission_key: submitted.submissionKey,
            record_key: submitted.recordKey,
            verdict: submitted.verdict,
            review_task: {
              task_key: submitted.reviewTask.key,
              status: submitted.reviewTask.status,
              version: submitted.reviewTask.version,
            },
            parent_checklist: submitted.parentChecklist,
            parent_task: {
              task_key: submitted.parentTask.key,
              status: submitted.parentTask.status,
              version: submitted.parentTask.version,
            },
          },
        });
      }
      if (composite[0]?.operation === "verify_and_complete") {
        const item = composite[0];
        const completed = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            taskKey: item.task_key,
            expectedVersion: item.expected_version,
          },
          () =>
            service.verifyAndComplete(input.project, input.session, input.op_id, {
              taskKey: item.task_key,
              expectedVersion: item.expected_version,
            }),
        );
        return result({
          ok: true,
          ...mutationAck(input.op_id, completed as unknown as Record<string, unknown>),
          project: input.project.toUpperCase(),
          seq: completed.sequence,
          items: [
            {
              task_key: completed.taskKey,
              from_status: completed.fromStatus,
              status: completed.status,
              from_version: completed.fromVersion,
              version: completed.taskVersion,
              transitions: completed.transitions,
            },
          ],
        });
      }
      if (composite[0]?.operation === "checklist_batch") {
        const item = checklistBatchPatchInput.parse(composite[0]);
        const updated = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            taskKey: item.task_key,
            expectedVersion: item.expected_version,
          },
          () =>
            service.updateChecklistBatch(input.project, input.session, input.op_id, {
              taskKey: item.task_key,
              expectedVersion: item.expected_version,
              items: item.checklist_items.map((checklistItem) => ({
                checklistId: checklistItem.id,
                status: checklistItem.status,
                ...(checklistItem.evidence === undefined
                  ? {}
                  : { evidence: checklistItem.evidence }),
              })),
            }),
        );
        return result({
          ok: true,
          ...mutationAck(input.op_id, updated as unknown as Record<string, unknown>),
          project: input.project.toUpperCase(),
          seq: updated.sequence,
          task_key: updated.taskKey,
          task_version: updated.taskVersion,
          progress: updated.taskProgress,
          updated_count: updated.updatedCount,
          items: updated.checklist.map((checklistItem) => ({
            id: checklistItem.id,
            status: checklistItem.status,
            version: checklistItem.version,
            evidence: checklistItem.evidence.length,
          })),
        });
      }
      if (composite[0]?.operation === "checklist_single") {
        const item = checklistSinglePatchInput.parse(composite[0]);
        const checklistItem = item.checklist_items[0]!;
        const updated = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            checklistId: checklistItem.id,
            expectedVersion: item.expected_version,
          },
          () =>
            service.updateChecklist(input.project, input.session, input.op_id, {
              checklistId: checklistItem.id,
              expectedVersion: item.expected_version,
              status: checklistItem.status,
              ...(checklistItem.evidence === undefined ? {} : { evidence: checklistItem.evidence }),
            }),
        );
        return result({
          ok: true,
          ...mutationAck(input.op_id, updated as unknown as Record<string, unknown>),
          project: input.project.toUpperCase(),
          seq: updated.sequence,
          task_key: item.task_key,
          id: checklistItem.id,
          status: updated.checklist.status,
          version: updated.checklist.version,
          evidence: updated.checklist.evidence.length,
          task_version: updated.taskVersion,
        });
      }
      const conflictItem = input.items[0];
      const patched = await withMcpErrorDetails(
        service,
        {
          project: input.project,
          ...(conflictItem === undefined
            ? {}
            : {
                taskKey: conflictItem.task_key,
                expectedVersion: conflictItem.expected_version,
                expectedVersions: Object.fromEntries(
                  input.items.map((item) => [item.task_key, item.expected_version]),
                ),
              }),
        },
        () =>
          service.patchWorkItems(
            input.project,
            input.session,
            input.op_id,
            input.items.map((item) => coreWorkItemPatch(item) as any),
          ),
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
    "atm_progress_add",
    {
      description: "写任务或项目进度。",
      inputSchema: z
        .object({
          project: projectCode,
          session: sessionId,
          op_id: opId,
          scope: z.enum(["task", "project"]),
          task_key: taskKey.optional(),
          summary: z.string().min(1).max(500),
          percent: z.number().min(0).max(100).optional(),
          completed: z.array(progressCompleted).max(20).default([]),
          evidence: z.array(EvidenceInputSchema).max(20).default([]),
          health: z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK", "UNKNOWN"]).nullable().optional(),
          blocker: z.string().max(1000).nullable().optional(),
          next: z.array(z.string().max(500)).max(20).default([]),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.scope === "task" && value.health !== undefined) {
            context.addIssue({
              code: "custom",
              path: ["health"],
              message: "health 仅适用于 project scope",
            });
          }
          if (value.scope === "project" && value.percent !== undefined) {
            context.addIssue({
              code: "custom",
              path: ["percent"],
              message: "percent 仅适用于 task scope",
            });
          }
        }),
      outputSchema,
    },
    async (input) => {
      const completed = input.completed.map((entry) =>
        typeof entry === "string"
          ? entry
          : {
              text: entry.text,
              ...(entry.work_item_key === undefined ? {} : { workItemKey: entry.work_item_key }),
            },
      );
      if (input.scope === "project") {
        const update = await service.addProjectProgress(input.project, input.session, input.op_id, {
          summary: input.summary,
          completed,
          next: input.next,
          ...(input.health === undefined ? {} : { health: input.health }),
          ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
          evidence: input.evidence,
        });
        return result({
          ok: true,
          ...mutationAck(input.op_id, update as unknown as Record<string, unknown>),
          update: update.id,
          health: update.health,
          unlinked: update.unlinked,
          open_work_items: update.openWorkItems,
          seq: update.seq,
        });
      }
      if (!input.task_key) throw new Error("VALIDATION_ERROR: task scope 要求 task_key");
      const updated = await service.addProgress(input.project, input.session, input.op_id, {
        taskKey: input.task_key,
        summary: input.summary,
        completed,
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
      inputSchema: z
        .object({
          project: projectCode,
          session: sessionId,
          op_id: opId,
          kind: z.enum(["DECISION", "CONSTRAINT", "FACT", "RISK", "REFERENCE", "LESSON"]),
          title: z.string().min(1).max(400),
          summary: recordSummary,
          detail: z.string().max(100_000).default(""),
          work_item_key: taskKey.nullable().optional(),
          supersedes: z.string().nullable().optional(),
          topic: RecordTopicSchema.nullable().optional(),
          subject_key: RecordSubjectKeySchema.nullable().optional(),
          importance: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).default("NORMAL"),
          scope: z.string().max(100).default("PROJECT"),
        })
        .strict(),
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
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        ...(input.subject_key === undefined ? {} : { subjectKey: input.subject_key }),
      });
      return result({
        ok: true,
        ...mutationAck(input.op_id, created as unknown as Record<string, unknown>),
        record: created.key,
        version: created.v,
        seq: created.seq,
        topic: input.topic ?? null,
        subject_key: input.subject_key ?? null,
        related_records: Array.isArray(created.relatedRecords) ? created.relatedRecords : [],
      });
    },
  );

  server.registerTool(
    "atm_search",
    {
      description: "搜索事实。",
      inputSchema: z
        .object({
          project: projectCode.optional(),
          query: z.string().trim().min(1).max(500).optional(),
          op_id: opId.optional(),
          session: sessionId.optional(),
          limit: z.number().int().min(1).max(30).default(20),
          cursor: z.string().optional(),
          field_mask: z.array(z.string()).max(20).default([]),
          max_chars: z.number().int().min(300).max(50_000).default(6000),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.query === undefined && value.op_id === undefined) {
            context.addIssue({
              code: "custom",
              path: ["query"],
              message: "query 或 op_id 至少提供一个",
            });
            context.addIssue({
              code: "custom",
              path: ["op_id"],
              message: "query 或 op_id 至少提供一个",
            });
          }
          if (value.session !== undefined && value.op_id === undefined) {
            context.addIssue({
              code: "custom",
              path: ["session"],
              message: "session 仅可与 op_id 精确回查一起使用",
            });
          }
        }),
      outputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      if (input.op_id !== undefined) {
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
      if (input.query.startsWith("op:")) {
        if (!input.project) throw new Error("PROJECT_REQUIRED: op_id 精确回查要求 project");
        const exactOpId = input.query.slice(3).trim();
        if (!exactOpId) throw new Error("VALIDATION_ERROR: op: 后必须提供 op_id");
        const trace = compactOperationTrace(
          plain(await service.getOperationTrace(input.project, opId.parse(exactOpId))),
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
      inputSchema: z
        .object({
          project: projectCode,
          since_seq: z.number().int().nonnegative(),
          limit: z.number().int().min(1).max(100).default(50),
          types: z.array(z.string()).max(50).default([]),
          max_chars: z.number().int().min(1000).max(50_000).default(12_000),
        })
        .strict(),
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
      inputSchema: z
        .object({
          project: projectCode,
          session: sessionId,
          op_id: opId,
          outcome: z.enum(["completed", "paused", "blocked", "cancelled", "error", "retired"]),
          summary: z.string().min(1).max(500),
          next: z.array(z.string().max(500)).max(20).default([]),
          release_claims: z.boolean().default(true),
          retirement_reason: z.string().max(500).nullable().optional(),
        })
        .strict(),
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

  const activeTools = new Set(mcpProfileTools[profile]);
  const registered = (
    server as unknown as { _registeredTools: Record<string, { enabled: boolean }> }
  )._registeredTools;
  for (const [name, tool] of Object.entries(registered)) {
    tool.enabled = activeTools.has(name);
  }
  installProjectErrorDetails(server, service);
  installCompactToolList(server);
  return server;
}

export { result as mcpResult };

export async function handleAyanamiMcpHttp(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  service: AyanamiTaskService,
  options: { profile?: AyanamiMcpProfile } = {},
): Promise<void> {
  const server = createAyanamiMcpServer(service, options);
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
