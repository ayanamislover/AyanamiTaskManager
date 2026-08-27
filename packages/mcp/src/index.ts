import { createInterface } from "node:readline";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable, Writable } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { asAtmError, AtmError } from "@ayanami-task/errors";
import {
  BeginInputSchema,
  BeginSignalsSchema,
  ChecklistBatchItemInputSchema,
  ChecklistCreateInputSchema,
  EvidenceInputSchema,
  type ExternalNameMap,
  RECORD_SUMMARY_CODE_POINT_LIMIT,
  RecordSubjectKeySchema,
  RecordSummarySchema,
  RecordTopicSchema,
  ReviewCandidateHashSchema,
  TASK_PATCH_OPERATION_NAMES,
  TaskCreateBatchInputSchema,
  TaskPatchOperations,
  WorkItemCreateInputSchema,
  WorkItemExpectedFieldsSchema,
  externalizeObjectSchema,
  type TaskPatchItem,
  type TaskPatchOperation,
  unicodeCodePointLength,
} from "@ayanami-task/protocol";
import {
  ToolDefinitionRegistry,
  type AyanamiServerProfile,
  type AyanamiToolProfile,
  type DefineToolConfig,
} from "./tool-registry.js";
import { registerPublishedToolHandlers } from "./tool-publication.js";

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
export type AyanamiMcpProfile = AyanamiServerProfile;

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

type MutationEntityReference = {
  entity_type: string;
  key: string;
  version: number | null;
};

const MUTATION_ACK_ENTITY_LIMIT = 12;
const MUTATION_ACK_ENTITY_CHARS = 1800;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function uniqueMutationEntityReferences(
  references: MutationEntityReference[],
): MutationEntityReference[] {
  const unique = new Map<string, MutationEntityReference>();
  for (const reference of references) {
    const identity = `${reference.entity_type}\0${reference.key}`;
    const previous = unique.get(identity);
    if (!previous || (previous.version === null && reference.version !== null)) {
      unique.set(identity, reference);
    }
  }
  return [...unique.values()];
}

function mutationEntityReferences(
  operation: string,
  serviceResult: Record<string, unknown>,
): MutationEntityReference[] {
  const references: MutationEntityReference[] = [];
  const add = (entityType: string, key: unknown, version: unknown = null) => {
    if (typeof key !== "string" || !key.trim()) return;
    references.push({
      entity_type: entityType,
      key,
      version: typeof version === "number" && Number.isSafeInteger(version) ? version : null,
    });
  };
  const addWorkItems = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const value of items) {
      const item = objectValue(value);
      add("WORK_ITEM", item.key ?? item.taskKey, item.version ?? item.taskVersion);
    }
  };

  switch (operation) {
    case "work.create.batch":
    case "work.patch.batch":
      addWorkItems(serviceResult.items);
      break;
    case "work.verify-and-complete":
      add("WORK_ITEM", serviceResult.taskKey, serviceResult.taskVersion);
      break;
    case "review.request.create": {
      const request = objectValue(serviceResult.request);
      add("REVIEW_REQUEST", request.key);
      add("WORK_ITEM", request.reviewTaskKey);
      add("WORK_ITEM", request.parentTaskKey);
      add("CHECKLIST", request.parentChecklistId, request.parentChecklistVersion);
      break;
    }
    case "review.submit": {
      add("REVIEW_REQUEST", serviceResult.requestKey);
      add("REVIEW_SUBMISSION", serviceResult.submissionKey);
      add("RECORD", serviceResult.recordKey);
      const reviewTask = objectValue(serviceResult.reviewTask);
      const parentChecklist = objectValue(serviceResult.parentChecklist);
      const parentTask = objectValue(serviceResult.parentTask);
      add("WORK_ITEM", reviewTask.key, reviewTask.version);
      add("CHECKLIST", parentChecklist.id, parentChecklist.version);
      add("WORK_ITEM", parentTask.key, parentTask.version);
      break;
    }
    case "checklist.update": {
      const checklist = objectValue(serviceResult.checklist);
      add("WORK_ITEM", serviceResult.taskKey, serviceResult.taskVersion);
      add("CHECKLIST", checklist.id, checklist.version);
      break;
    }
    case "checklist.update.batch":
      add("WORK_ITEM", serviceResult.taskKey, serviceResult.taskVersion);
      if (Array.isArray(serviceResult.checklist)) {
        for (const value of serviceResult.checklist) {
          const checklist = objectValue(value);
          add("CHECKLIST", checklist.id, checklist.version);
        }
      }
      break;
    case "work.progress":
      add("WORK_ITEM", serviceResult.key, serviceResult.v);
      add("PROGRESS", serviceResult.progressId);
      break;
    case "project-update.publish":
      add("PROJECT_UPDATE", serviceResult.id, serviceResult.version);
      break;
    case "record.create":
      add("RECORD", serviceResult.key, serviceResult.v);
      break;
    case "session.end":
      add("SESSION", serviceResult.session, serviceResult.version);
      break;
  }

  return uniqueMutationEntityReferences(references);
}

function mutationEntityPreview(entities: MutationEntityReference[]): MutationEntityReference[] {
  const preview: MutationEntityReference[] = [];
  let chars = 2;
  for (const entity of entities) {
    if (preview.length >= MUTATION_ACK_ENTITY_LIMIT) break;
    const entityChars = JSON.stringify(entity).length + (preview.length === 0 ? 0 : 1);
    if (chars + entityChars > MUTATION_ACK_ENTITY_CHARS) break;
    preview.push(entity);
    chars += entityChars;
  }
  return preview;
}

function mutationAck(
  project: string,
  requestedSession: string,
  opId: string,
  operation: string,
  serviceResult: Record<string, unknown>,
) {
  const reboundSession =
    typeof serviceResult.newSession === "string"
      ? serviceResult.newSession
      : typeof serviceResult.session === "string"
        ? serviceResult.session
        : undefined;
  const session = serviceResult.sessionRebound === true ? reboundSession : requestedSession;
  if (session === undefined) {
    throw new AtmError("INTERNAL_ERROR", {
      message: "mutation acknowledgement 缺少 Session",
      details: { operation_id: opId },
    });
  }
  const entities = mutationEntityReferences(operation, serviceResult);
  const preview = mutationEntityPreview(entities);
  const normalizedProject = project.toUpperCase();
  return {
    ok: true,
    op_id: opId,
    project: normalizedProject,
    session,
    session_rebound: serviceResult.sessionRebound === true,
    entities: preview,
    entity_count: entities.length,
    entities_truncated: preview.length < entities.length,
    details_cursor: {
      name: "atm_search",
      arguments: {
        project: normalizedProject,
        op_id: opId,
        session,
        field_mask: ["op_id", "entities"],
        max_chars: 50_000,
      },
    },
  };
}

type McpErrorContext = {
  project?: string;
  taskKey?: string;
  checklistId?: string;
  expectedVersion?: number;
  expectedVersions?: Record<string, number>;
};

async function withMcpErrorDetails<T>(
  service: AyanamiTaskService,
  context: McpErrorContext,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const base = asAtmError(error);
    if (typeof service.enrichError !== "function") throw base;
    let enriched: AtmError;
    try {
      enriched = await service.enrichError(base, {
        ...(context.project === undefined ? {} : { projectCode: context.project }),
        ...(context.taskKey === undefined ? {} : { taskKey: context.taskKey }),
        ...(context.checklistId === undefined ? {} : { checklistId: context.checklistId }),
        ...(context.expectedVersion === undefined
          ? {}
          : { expectedVersion: context.expectedVersion }),
        ...(context.expectedVersions === undefined
          ? {}
          : { expectedVersions: context.expectedVersions }),
      });
    } catch {
      throw base;
    }
    throw enriched;
  }
}

type FieldCursor = {
  v: 2;
  project: string;
  entity: string;
  entityType: string;
  maskHash: string;
  path: Array<string | number>;
  contentHash: string;
  targetVersion: string;
  expiresAt: number;
  offset: number;
};

type FieldReadTarget = {
  project: string;
  entity: string;
  entityType: string;
  fieldMask: string[];
  targetVersion: string;
};

const FIELD_CURSOR_PREFIX = "f2";
const FIELD_CURSOR_HASH_DOMAIN = "AYANAMI_TASK_MANAGER_FIELD_CURSOR_V2\0";
const FIELD_CURSOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function fieldContentHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest().subarray(0, 16).toString("base64url");
}

function fieldMaskHash(fieldMask: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(fieldMask), "utf8")
    .digest()
    .subarray(0, 12)
    .toString("base64url");
}

function fieldTargetVersion(value: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

function fieldCursorExpiry(now = Date.now()): number {
  // Bucketed expiry keeps an otherwise identical cursor deterministic across
  // process restarts. Advancing two bucket edges guarantees at least one full
  // TTL even when the cursor is created immediately before a boundary.
  return (Math.floor(now / FIELD_CURSOR_TTL_MS) + 2) * FIELD_CURSOR_TTL_MS;
}

function normalizedFieldTarget(target: FieldReadTarget) {
  return {
    project: target.project.trim().toUpperCase(),
    entity: target.entity.trim(),
    entityType: target.entityType.trim().toUpperCase(),
    maskHash: fieldMaskHash(target.fieldMask),
    targetVersion: target.targetVersion,
  };
}

function encodeFieldCursor(cursor: FieldCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  const signature = createHash("sha256")
    .update(FIELD_CURSOR_HASH_DOMAIN, "utf8")
    .update(payload, "utf8")
    .digest()
    .subarray(0, 16)
    .toString("base64url");
  return `${FIELD_CURSOR_PREFIX}.${payload}.${signature}`;
}

function decodeFieldCursor(token: string): FieldCursor {
  let value: FieldCursor;
  try {
    const [prefix, payload, signature, extra] = token.split(".");
    if (prefix !== FIELD_CURSOR_PREFIX || !payload || !signature || extra !== undefined) {
      throw new Error("invalid token shape");
    }
    if (Buffer.from(payload, "base64url").toString("base64url") !== payload) {
      throw new Error("invalid payload encoding");
    }
    const expected = createHash("sha256")
      .update(FIELD_CURSOR_HASH_DOMAIN, "utf8")
      .update(payload, "utf8")
      .digest()
      .subarray(0, 16);
    const received = Buffer.from(signature, "base64url");
    if (
      received.toString("base64url") !== signature ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      throw new Error("invalid signature");
    }
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as FieldCursor;
    if (
      value.v !== 2 ||
      typeof value.project !== "string" ||
      !value.project ||
      typeof value.entity !== "string" ||
      !value.entity ||
      typeof value.entityType !== "string" ||
      !value.entityType ||
      typeof value.maskHash !== "string" ||
      !value.maskHash ||
      !Array.isArray(value.path) ||
      value.path.length === 0 ||
      value.path.length > 64 ||
      value.path.some((part) => typeof part !== "string" && !Number.isInteger(part)) ||
      typeof value.contentHash !== "string" ||
      !value.contentHash ||
      typeof value.targetVersion !== "string" ||
      !value.targetVersion ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= 0 ||
      !Number.isInteger(value.offset) ||
      value.offset < 0
    ) {
      throw new Error("invalid shape");
    }
  } catch {
    throw new AtmError("INVALID_CURSOR", {
      message: "continuation cursor 无效或已损坏",
      details: {
        reason: "INVALID_OR_TAMPERED",
        recovery: { action: "restart_read", omit_cursor: true },
      },
    });
  }
  if (value.expiresAt <= Date.now()) {
    throw new AtmError("INVALID_CURSOR", {
      message: "continuation cursor 已过期，请重新读取",
      details: {
        reason: "EXPIRED",
        recovery: { action: "restart_read", omit_cursor: true },
      },
    });
  }
  return value;
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
  target: FieldReadTarget,
): Record<string, unknown> {
  const cursor = decodeFieldCursor(cursorToken);
  const expectedTarget = normalizedFieldTarget(target);
  if (
    cursor.project !== expectedTarget.project ||
    cursor.entity !== expectedTarget.entity ||
    cursor.entityType !== expectedTarget.entityType ||
    cursor.maskHash !== expectedTarget.maskHash
  ) {
    throw new AtmError("CONTINUATION_CONFLICT", {
      message: "field continuation 请求身份已变化",
      details: {
        reason: "TARGET_MISMATCH",
        recovery: { action: "retry_original_target", preserve_cursor: true },
      },
    });
  }
  if (cursor.targetVersion !== expectedTarget.targetVersion) {
    throw new AtmError("CONTINUATION_CONFLICT", {
      message: "field continuation 目标版本已变化",
      details: {
        reason: "STALE",
        recovery: { action: "restart_read", omit_cursor: true },
      },
    });
  }
  const field = getAtPath(source, cursor.path);
  if (
    typeof field !== "string" ||
    cursor.offset > field.length ||
    fieldContentHash(field) !== cursor.contentHash
  ) {
    throw new AtmError("CONTINUATION_CONFLICT", {
      message: "field continuation 内容已变化",
      details: {
        reason: "STALE",
        recovery: { action: "restart_read", omit_cursor: true },
      },
    });
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
      next_cursor: done ? null : encodeFieldCursor({ ...cursor, offset: nextOffset }),
    };
    if (JSON.stringify(candidate).length <= maxChars) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  if (!best || best.returned_chars === 0) {
    throw new AtmError("RESULT_TOO_LARGE", {
      message: `max_chars=${maxChars} 无法容纳 continuation 回执`,
      details: {
        max_chars: maxChars,
        recovery: { action: "increase_max_chars", preserve_cursor: true },
      },
    });
  }
  return best;
}

function fitFieldRead(
  source: Record<string, unknown>,
  maxChars: number,
  tool: "atm_task_get" | "atm_search",
  target: FieldReadTarget,
  cursor?: string,
): Record<string, unknown> {
  if (cursor) return continueField(source, cursor, maxChars, target);
  if (JSON.stringify(source).length <= maxChars) return source;
  const normalizedTarget = normalizedFieldTarget(target);

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
          cursor: encodeFieldCursor({
            v: 2,
            ...normalizedTarget,
            path,
            contentHash: fieldContentHash(value),
            targetVersion: normalizedTarget.targetVersion,
            expiresAt: fieldCursorExpiry(),
            offset: returned.length,
          }),
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
const BRIEF_CURSOR_TTL_MS = 30 * 60 * 1000;
const BRIEF_CURSOR_PREFIX = "b2";
const BRIEF_CURSOR_HASH_DOMAIN = "AYANAMI_TASK_MANAGER_BRIEF_CURSOR_V2\0";

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

type BriefRecordSnapshot = readonly [key: string, version: string];

type BriefCursor = {
  v: 2;
  p: string;
  s: string;
  i: number;
  q: string;
  x: "records";
  o: number;
  r: BriefRecordSnapshot[];
  n: number;
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

function briefCursorExpiry(now = Date.now()): number {
  // Keep tokens deterministic inside a time bucket while guaranteeing that a
  // cursor created just before the next boundary still receives a full TTL.
  return (Math.floor(now / BRIEF_CURSOR_TTL_MS) + 2) * BRIEF_CURSOR_TTL_MS;
}

function briefRecordEntries(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const records = Array.isArray(payload.records)
    ? (payload.records as Array<Record<string, unknown>>)
    : [];
  return records.filter((record) => typeof record.key === "string" && record.key.length > 0);
}

function briefRecordVersion(record: Record<string, unknown>): string {
  return briefHash(record, 12);
}

async function captureBriefRecordSnapshot(
  service: AyanamiTaskService,
  project: string,
  payload: Record<string, unknown>,
): Promise<BriefRecordSnapshot[]> {
  return await Promise.all(
    briefRecordEntries(payload).map(async (record) => {
      const key = String(record.key);
      const canonical = plain(await service.getRecord(project, key));
      return [key, briefRecordVersion(canonical)] as const;
    }),
  );
}

function staleBriefRecord(key: string): AtmError<"CONTINUATION_CONFLICT"> {
  return new AtmError("CONTINUATION_CONFLICT", {
    message: `brief continuation 选择的 Record 已变化：${key}`,
    details: {
      reason: "STALE",
      recovery: { action: "restart_read", omit_cursor: true },
      record_key: key,
    },
  });
}

function projectBriefRecord(record: Record<string, unknown>): Record<string, unknown> {
  return {
    key: record.key,
    kind: record.kind,
    summary: record.summary,
    importance: record.importance,
  };
}

async function resolveBriefRecordSnapshot(
  service: AyanamiTaskService,
  project: string,
  cursor: BriefCursor,
  payload: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const current = new Map(
    briefRecordEntries(payload).map((record) => [String(record.key), record] as const),
  );
  const resolved: Array<Record<string, unknown>> = [];
  for (const [key, expectedVersion] of cursor.r) {
    let canonical: Record<string, unknown>;
    try {
      canonical = plain(await service.getRecord(project, key));
    } catch (error) {
      if (error instanceof AtmError && error.code === "RECORD_NOT_FOUND") {
        throw staleBriefRecord(key);
      }
      throw error;
    }
    if (briefRecordVersion(canonical) !== expectedVersion) throw staleBriefRecord(key);
    resolved.push(current.get(key) ?? projectBriefRecord(canonical));
  }
  return resolved;
}

function encodeBriefCursor(cursor: BriefCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  const signature = createHash("sha256")
    .update(BRIEF_CURSOR_HASH_DOMAIN, "utf8")
    .update(payload, "utf8")
    .digest()
    .subarray(0, 16)
    .toString("base64url");
  return `${BRIEF_CURSOR_PREFIX}.${payload}.${signature}`;
}

function decodeBriefCursor(token: string): BriefCursor {
  const expired = Symbol("brief-cursor-expired");
  try {
    const [prefix, payload, signature, extra] = token.split(".");
    if (prefix !== BRIEF_CURSOR_PREFIX || !payload || !signature || extra !== undefined) {
      throw new Error("shape");
    }
    if (Buffer.from(payload, "base64url").toString("base64url") !== payload) {
      throw new Error("encoding");
    }
    const expected = createHash("sha256")
      .update(BRIEF_CURSOR_HASH_DOMAIN, "utf8")
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
      value.v !== 2 ||
      typeof value.p !== "string" ||
      typeof value.s !== "string" ||
      !Number.isInteger(value.i) ||
      typeof value.q !== "string" ||
      value.x !== "records" ||
      !Number.isInteger(value.o) ||
      value.o < 0 ||
      !Array.isArray(value.r) ||
      value.r.length === 0 ||
      value.r.length > 8 ||
      value.r.some(
        (record) =>
          !Array.isArray(record) ||
          record.length !== 2 ||
          typeof record[0] !== "string" ||
          !record[0] ||
          typeof record[1] !== "string" ||
          !record[1],
      ) ||
      value.o > value.r.length ||
      !Number.isSafeInteger(value.n) ||
      value.n < 0 ||
      !Number.isSafeInteger(value.e) ||
      value.e <= 0
    ) {
      throw new Error("shape");
    }
    if (Date.now() > value.e) throw expired;
    return value;
  } catch (error) {
    if (error === expired) {
      throw new AtmError("INVALID_CURSOR", {
        message: "brief continuation 已过期，请重新读取",
        details: {
          reason: "EXPIRED",
          recovery: { action: "restart_read", omit_cursor: true },
        },
      });
    }
    throw new AtmError("INVALID_CURSOR", {
      message: "brief continuation 无效或已被篡改",
      details: {
        reason: "INVALID_OR_TAMPERED",
        recovery: { action: "restart_read", omit_cursor: true },
      },
    });
  }
}

function makeBriefCursor(input: {
  project: string;
  sessionId?: string;
  include: readonly BriefSection[];
  taskKey?: string;
  sinceSeq?: number;
  offset: number;
  recordSnapshot: BriefRecordSnapshot[];
  snapshotSeq: number;
}): string {
  return encodeBriefCursor({
    v: 2,
    p: input.project.toUpperCase(),
    s: input.sessionId ?? "",
    i: briefIncludeMask(input.include),
    q: briefQueryHash(input.taskKey, input.sinceSeq),
    x: "records",
    o: input.offset,
    r: input.recordSnapshot,
    n: input.snapshotSeq,
    e: briefCursorExpiry(),
  });
}

function validateBriefCursorRequest(
  cursor: BriefCursor,
  input: {
    project: string;
    sessionId?: string;
    include: readonly BriefSection[];
    taskKey?: string;
    sinceSeq?: number;
  },
): void {
  if (
    cursor.p !== input.project.toUpperCase() ||
    cursor.s !== (input.sessionId ?? "") ||
    cursor.i !== briefIncludeMask(input.include) ||
    cursor.q !== briefQueryHash(input.taskKey, input.sinceSeq)
  ) {
    throw new AtmError("CONTINUATION_CONFLICT", {
      message: "brief continuation 请求身份已变化",
      details: {
        reason: "TARGET_MISMATCH",
        recovery: { action: "retry_original_target", preserve_cursor: true },
      },
    });
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
  recordSnapshot?: BriefRecordSnapshot[];
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
  const recordSnapshot = input.recordSnapshot ?? [];
  const snapshotSeq =
    typeof frozenSource.seq === "number" && Number.isSafeInteger(frozenSource.seq)
      ? frozenSource.seq
      : 0;
  if (records.length !== recordSnapshot.length && records.length > 0) {
    throw new AtmError("INVALID_RESPONSE", {
      message: "brief Record snapshot 与返回集合不一致",
      details: { records: records.length, versions: recordSnapshot.length },
    });
  }
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
            ...(input.taskKey === undefined ? {} : { taskKey: input.taskKey }),
            ...(input.sinceSeq === undefined ? {} : { sinceSeq: input.sinceSeq }),
            offset: recordCount,
            recordSnapshot,
            snapshotSeq,
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

    // 极窄预算可能连带 continuation cursor 都放不下。身份回执仍逐字保留，不伪造一个
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
  records: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const source = pickBriefSections(input.payload, input.include);
  let returned = records.length - cursor.o;
  const currentSeq =
    typeof source.seq === "number" && Number.isSafeInteger(source.seq) ? source.seq : cursor.n;
  for (;;) {
    const nextOffset = cursor.o + returned;
    const nextCursor =
      nextOffset < records.length ? encodeBriefCursor({ ...cursor, o: nextOffset }) : undefined;
    const candidate: Record<string, unknown> = {
      project: source.project,
      seq: source.seq,
      ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
      records: records.slice(cursor.o, nextOffset),
      offset: cursor.o,
      returned_items: returned,
      total_items: records.length,
      truncated: nextCursor !== undefined,
      ...(currentSeq > cursor.n
        ? { snapshot_advanced_from: cursor.n, snapshot_advanced_to: currentSeq }
        : {}),
      ...(nextCursor === undefined
        ? {}
        : { continuation: { tool: "atm_brief", cursor: nextCursor } }),
    };
    if (JSON.stringify(candidate).length <= input.maxChars) return candidate;
    if (returned > 0) {
      returned -= 1;
      continue;
    }
    throw new AtmError("RESULT_TOO_LARGE", {
      message: `max_chars=${input.maxChars} 无法容纳一条完整 Record continuation`,
      details: {
        max_chars: input.maxChars,
        recovery: { action: "increase_max_chars", preserve_cursor: true },
      },
    });
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
  recordSnapshot: BriefRecordSnapshot[],
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
    recordSnapshot,
  });
}

const beginSignalNames = {
  expectedMinutes: "expected_minutes",
  subtaskCount: "subtask_count",
  multiSession: "multi_session",
  multiAgent: "multi_agent",
  hasDependencies: "has_dependencies",
  needsEvidence: "needs_evidence",
  hasTargetDate: "has_target_date",
} as const satisfies ExternalNameMap<typeof BeginSignalsSchema>;
const beginSignalsExternal = externalizeObjectSchema(BeginSignalsSchema, beginSignalNames);

const beginNames = {
  operationId: "op_id",
  cwd: "cwd",
  projectCode: "project_code",
  title: "title",
  mode: "mode",
  agentId: "agent_id",
  displayName: "display_name",
  clientKind: "client_kind",
  threadId: "thread_id",
  parentSessionId: "parent_session_id",
  resume: "resume",
  predecessorSessionId: "predecessor_session_id",
  maxChars: "max_chars",
  role: "role",
  signals: "signals",
  allowProjectCreate: "allow_project_create",
  creationReason: "creation_reason",
} as const satisfies ExternalNameMap<typeof BeginInputSchema>;
const beginExternal = externalizeObjectSchema(BeginInputSchema, beginNames, {
  signals: {
    schema: beginSignalsExternal.inputSchema.default({}),
    decode: (value) => beginSignalsExternal.parse(value),
  },
});
const beginFields = beginExternal.inputSchema.shape;
const beginToolInput = z
  .object({
    op_id: beginFields.op_id!,
    cwd: beginFields.cwd!,
    project_code: beginFields.project_code!,
    title: beginFields.title!,
    mode: beginFields.mode!,
    agent_id: beginFields.agent_id!,
    display_name: beginFields.display_name!,
    client_kind: beginFields.client_kind!,
    thread_id: beginFields.thread_id!,
    parent_session_id: beginFields.parent_session_id!,
    resume: beginFields.resume!,
    brief: z.enum(["none", "minimal", "full"]).default("full"),
    max_chars: beginFields.max_chars!,
    predecessor_session_id: beginFields.predecessor_session_id!,
    role: beginFields.role!,
    signals: beginFields.signals!,
    allow_project_create: beginFields.allow_project_create!,
    creation_reason: beginFields.creation_reason!,
  })
  .strict();

const checklistCreateNames = {
  title: "title",
  evidenceRequired: "evidence_required",
  weight: "weight",
} as const satisfies ExternalNameMap<typeof ChecklistCreateInputSchema>;
const checklistCreateExternal = externalizeObjectSchema(
  ChecklistCreateInputSchema,
  checklistCreateNames,
);

const workItemCreateNames = {
  clientRef: "client_ref",
  objectiveId: "objective_id",
  milestoneId: "milestone_id",
  parentKey: "parent_key",
  parentRef: "parent_ref",
  dependsOn: "depends_on",
  dependsOnRefs: "depends_on_refs",
  discoveredFrom: "discovered_from",
  discoveredFromRef: "discovered_from_ref",
  title: "title",
  description: "description",
  type: "type",
  priority: "priority",
  status: "status",
  acceptance: "acceptance",
  checklist: "checklist",
  weight: "weight",
  targetDate: "target_date",
  verificationRequired: "verification_required",
  assigneeAgentId: "assignee_agent_id",
} as const satisfies ExternalNameMap<typeof WorkItemCreateInputSchema>;
const workItemCreateExternal = externalizeObjectSchema(
  WorkItemCreateInputSchema,
  workItemCreateNames,
  {
    checklist: {
      schema: z.array(checklistCreateExternal.inputSchema).max(100).default([]),
      decode: (value) =>
        (value as unknown[]).map((checklistItem) => checklistCreateExternal.parse(checklistItem)),
    },
  },
);

const taskCreateNames = {
  project: "project",
  session: "session",
  opId: "op_id",
  items: "items",
} as const satisfies ExternalNameMap<typeof TaskCreateBatchInputSchema>;
const taskCreateExternal = externalizeObjectSchema(TaskCreateBatchInputSchema, taskCreateNames, {
  items: {
    schema: z.array(workItemCreateExternal.inputSchema).min(1).max(50),
    decode: (value) =>
      (value as unknown[]).map((workItem) => workItemCreateExternal.parse(workItem)),
  },
});

const workItemExpectedFieldsExternal = externalizeObjectSchema(WorkItemExpectedFieldsSchema, {
  title: "title",
  description: "description",
  acceptance: "acceptance",
  targetDate: "target_date",
  parentKey: "parent_key",
} as const);
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
const checklistBatchItemExternal = externalizeObjectSchema(ChecklistBatchItemInputSchema, {
  checklistId: "id",
  status: "status",
  evidence: "evidence",
} as const);

const taskPatchExternalNames = {
  taskKey: "task_key",
  expectedVersion: "expected_version",
  takeoverStale: "takeover_stale",
  operation: "operation",
  expectedFields: "expected_fields",
  title: "title",
  description: "description",
  acceptance: "acceptance",
  blockedReason: "blocked_reason",
  waitingFor: "waiting_for",
  cancelReason: "cancel_reason",
  duplicateOf: "duplicate_of",
  supersededBy: "superseded_by",
  assigneeAgentId: "assignee_agent_id",
  targetDate: "target_date",
  parentKey: "parent_key",
  parentChecklistId: "parent_checklist_id",
  expectedParentChecklistVersion: "expected_parent_checklist_version",
  requestKey: "request_key",
  candidateHashes: "candidate_hashes",
  verdict: "verdict",
  evidence: "evidence",
  checklistItems: "checklist_items",
} as const;

const taskPatchFieldAdapters = {
  expectedFields: {
    schema: workItemExpectedFieldsExternal.inputSchema.optional(),
    decode: (value: unknown) => workItemExpectedFieldsExternal.parse(value),
  },
  candidateHashes: {
    schema: reviewCandidateHashMap,
    decode: (value: unknown) =>
      Object.entries(value as Record<string, string>).map(([name, hash]) => ({
        name,
        value: hash,
      })),
  },
  checklistItems: {
    schema: z.array(checklistBatchItemExternal.inputSchema).min(1).max(100),
    decode: (value: unknown) =>
      (value as unknown[]).map((item) => checklistBatchItemExternal.parse(item)),
  },
} as const;

const taskPatchExternalAdapters = Object.fromEntries(
  TASK_PATCH_OPERATION_NAMES.map((operation) => {
    const definition = TaskPatchOperations[operation];
    const fieldAdapters =
      operation === "checklist_single"
        ? {
            ...taskPatchFieldAdapters,
            checklistItems: {
              ...taskPatchFieldAdapters.checklistItems,
              schema: z.array(checklistBatchItemExternal.inputSchema).length(1),
            },
          }
        : taskPatchFieldAdapters;
    return [
      operation,
      externalizeObjectSchema(
        definition.schema as z.ZodObject<z.ZodRawShape>,
        taskPatchExternalNames as any,
        fieldAdapters as any,
      ),
    ];
  }),
) as Record<
  TaskPatchOperation,
  ReturnType<typeof externalizeObjectSchema<z.ZodObject<z.ZodRawShape>, any>>
>;

const coreTaskPatchOperations = TASK_PATCH_OPERATION_NAMES.filter(
  (operation) => TaskPatchOperations[operation].batchable,
);
const compositeTaskPatchOperations = TASK_PATCH_OPERATION_NAMES.filter(
  (operation) => !TaskPatchOperations[operation].batchable,
);
const coreWorkItemPatch = z.discriminatedUnion(
  "operation",
  coreTaskPatchOperations.map(
    (operation) => taskPatchExternalAdapters[operation].inputSchema,
  ) as any,
);
const compositeWorkItemPatch = z.discriminatedUnion(
  "operation",
  compositeTaskPatchOperations.map(
    (operation) => taskPatchExternalAdapters[operation].inputSchema,
  ) as any,
);
const workItemPatch = z.discriminatedUnion(
  "operation",
  TASK_PATCH_OPERATION_NAMES.map(
    (operation) => taskPatchExternalAdapters[operation].inputSchema,
  ) as any,
);

function canonicalTaskPatchItem(value: unknown): TaskPatchItem {
  const parsed = workItemPatch.parse(value) as Record<string, unknown> & {
    operation: TaskPatchOperation;
  };
  return taskPatchExternalAdapters[parsed.operation].parse(parsed) as TaskPatchItem;
}

const taskPatchToolInput = z
  .object({
    project: projectCode,
    session: sessionId,
    op_id: opId,
    items: z.union([
      z.array(coreWorkItemPatch).min(1).max(50),
      z.array(compositeWorkItemPatch).length(1),
    ]),
  })
  .strict();

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

function snakeCaseKey(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

/** MCP is the sole snake_case boundary; the canonical Application DTO remains camelCase. */
function externalizeTaskView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(externalizeTaskView);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      snakeCaseKey(key),
      externalizeTaskView(entry),
    ]),
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
  changes?: Record<string, unknown>;
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
      ...(event.changes && typeof event.changes === "object" ? { changes: event.changes } : {}),
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
      const restPath = `/api/v1/projects/${project.toUpperCase()}/events?since=${Math.max(0, firstEvent.seq - 1)}&limit=1`;
      candidate.next_seq = firstEvent.seq;
      const hasFollowingEvents = events.length > 1 || serviceHasMore;
      candidate.has_more = hasFollowingEvents;
      candidate.oversized_event = {
        seq: firstEvent.seq,
        type: firstEvent.type,
        key: firstEvent.key,
        op_id: firstEvent.op_id,
        chars: firstEventChars,
        continuation: {
          transport: "REST",
          method: "GET",
          authentication: "daemon_bearer",
          path: restPath,
        },
      };
      const continuation = candidate.continuation as Record<string, any> | undefined;
      if (continuation && hasFollowingEvents) {
        continuation.arguments.since_seq = firstEvent.seq;
      } else if (!hasFollowingEvents) {
        delete candidate.continuation;
      }
    }
    if (JSON.stringify(candidate).length <= maxChars) return candidate;
  }

  const firstEvent = events[0];
  return {
    project: projectInfo,
    since_seq: sinceSeq,
    requested_limit: requestedLimit,
    returned_count: 0,
    events: [],
    current_sequence: currentSequence,
    next_seq: firstEvent?.seq ?? sinceSeq,
    has_more: firstEvent === undefined ? serviceHasMore : events.length > 1 || serviceHasMore,
    truncated: events.length > 0,
    ...(firstEvent === undefined
      ? {}
      : {
          oversized_event: {
            seq: firstEvent.seq,
            continuation: {
              transport: "REST",
              method: "GET",
              authentication: "daemon_bearer",
              path: `/api/v1/projects/${project.toUpperCase()}/events?since=${Math.max(0, firstEvent.seq - 1)}&limit=1`,
            },
          },
        }),
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
    ...(hit.project === undefined ? {} : { project: hit.project }),
  };
}

type SearchServicePage = {
  hits: any[];
  nextCursor: string | null;
  hasMore: boolean;
};

async function fitSearchPage(input: {
  initial: SearchServicePage;
  fetchPage: (limit: number) => Promise<SearchServicePage> | SearchServicePage;
  requestedLimit: number;
  inputCursor?: string;
  fieldMask: string[];
  maxChars: number;
}): Promise<Record<string, unknown>> {
  const maximum = Math.min(input.requestedLimit, input.initial.hits.length);
  for (let count = maximum; count >= 1; count -= 1) {
    const page = count === input.requestedLimit ? input.initial : await input.fetchPage(count);
    const hits = page.hits
      .slice(0, count)
      .map((hit) => selectFields(compactSearchHit(plain(hit)), input.fieldMask));
    const candidate: Record<string, unknown> = {
      exact: false,
      requested_limit: input.requestedLimit,
      returned_count: hits.length,
      hits,
      next_cursor: page.hasMore ? page.nextCursor : null,
      has_more: page.hasMore,
      truncated: count < input.requestedLimit,
    };
    if (JSON.stringify(candidate).length <= input.maxChars) return candidate;
  }
  if (input.initial.hits.length === 0) {
    return {
      exact: false,
      requested_limit: input.requestedLimit,
      returned_count: 0,
      hits: [],
      next_cursor: null,
      has_more: false,
      truncated: false,
    };
  }
  const retry: Record<string, unknown> = {
    exact: false,
    returned_count: 0,
    hits: [],
    next_cursor: input.inputCursor ?? null,
    has_more: true,
    truncated: true,
  };
  if (JSON.stringify(retry).length <= input.maxChars) return retry;
  return {
    code: "RESULT_TOO_LARGE",
    next_cursor: input.inputCursor ?? null,
    has_more: true,
    truncated: true,
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

function compactProgress(progress: Record<string, unknown>): Record<string, unknown> {
  return {
    id: progress.id,
    task_key: progress.taskKey,
    percent: progress.percent,
    progress_bucket: progress.progressBucket,
    summary: progress.summary,
    completed: (Array.isArray(progress.completed) ? progress.completed : []).map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? {
            text: (entry as Record<string, unknown>).text,
            ...((entry as Record<string, unknown>).workItemKey === undefined
              ? {}
              : { work_item_key: (entry as Record<string, unknown>).workItemKey }),
          }
        : entry,
    ),
    next: Array.isArray(progress.next) ? progress.next : [],
    blocker: progress.blocker ?? null,
    actor: progress.actor,
    session_id: progress.sessionId ?? null,
    evidence: Array.isArray(progress.evidence) ? progress.evidence : [],
    op_id: progress.opId ?? null,
    created_at: progress.createdAt,
  };
}

function compactSession(session: Record<string, unknown>): Record<string, unknown> {
  const git = plain(session.git);
  return {
    id: session.id,
    agent_id: session.agentId,
    display_name: session.displayName,
    client_kind: session.clientKind,
    capabilities: Array.isArray(session.capabilities) ? session.capabilities : [],
    parent_session_id: session.parentSessionId ?? null,
    predecessor_session_id: session.predecessorSessionId ?? null,
    thread_id: session.threadId ?? null,
    role: session.role,
    cwd: session.cwd ?? null,
    work_state: session.workState,
    connection_state: session.connectionState,
    current_task_key: session.currentTaskKey ?? null,
    heartbeat_at: session.heartbeatAt ?? null,
    version: session.version,
    started_at: session.startedAt,
    updated_at: session.updatedAt,
    closed_at: session.closedAt ?? null,
    retirement_reason: session.retirementReason ?? null,
    close_reason: session.closeReason ?? null,
    git: {
      available: git.available === true,
      repo_root: git.repoRoot ?? null,
      worktree_root: git.worktreeRoot ?? null,
      common_dir: git.commonDir ?? null,
      is_linked_worktree: git.isLinkedWorktree ?? null,
      branch: git.branch ?? null,
      head: git.head ?? null,
      detached: git.detached ?? null,
      dirty: git.dirty ?? null,
      error: git.error ?? null,
    },
  };
}

function scopedUlidQuery(query: string): { kind: "PROGRESS" | "SESSION"; id: string } | null {
  const match = /^(progress|session):(.*)$/iu.exec(query.trim());
  if (!match) return null;
  const id = match[2]!.trim().toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(id)) {
    throw new AtmError("VALIDATION_ERROR", {
      message: `${match[1]!.toLowerCase()}: 后必须提供 ULID`,
    });
  }
  return { kind: match[1]!.toLowerCase() === "progress" ? "PROGRESS" : "SESSION", id };
}

function compactOperationTrace(trace: Record<string, any>): Record<string, unknown> {
  const mutations = (Array.isArray(trace.mutations) ? trace.mutations : []) as Array<
    Record<string, unknown>
  >;
  const events = (Array.isArray(trace.events) ? trace.events : []) as Array<
    Record<string, unknown>
  >;
  const entities = uniqueMutationEntityReferences(
    mutations.flatMap((mutation) =>
      mutationEntityReferences(typeof mutation.operation === "string" ? mutation.operation : "", {
        ...objectValue(mutation.response),
        ...(mutation.operation === "checklist.update"
          ? {
              taskKey: events
                .map((event) => objectValue(event.payload).taskKey)
                .find((key) => typeof key === "string"),
            }
          : {}),
      }),
    ),
  );
  return {
    op_id: trace.opId,
    entities,
    mutations: mutations.map((mutation: Record<string, unknown>) => ({
      operation: mutation.operation,
      response: mutation.response,
      session_id: mutation.sessionId,
      created_at: mutation.createdAt,
    })),
    records: (Array.isArray(trace.records) ? trace.records : []).map(
      (record: Record<string, unknown>) => compactRecord(record),
    ),
    progress: (Array.isArray(trace.progress) ? trace.progress : []).map(
      (progress: Record<string, unknown>) => compactProgress(progress),
    ),
    project_updates: (Array.isArray(trace.projectUpdates) ? trace.projectUpdates : []).map(
      (update: Record<string, unknown>) => ({
        id: update.id,
        health: update.health,
        summary: update.summary,
        completed: Array.isArray(update.completed) ? update.completed : [],
        risks: Array.isArray(update.risks) ? update.risks : [],
        next: Array.isArray(update.next) ? update.next : [],
        evidence: Array.isArray(update.evidence) ? update.evidence : [],
        from_sequence: update.fromSequence,
        to_sequence: update.toSequence,
        status: update.status,
        actor: update.actor,
        published_at: update.publishedAt ?? null,
        created_at: update.createdAt,
        updated_at: update.updatedAt,
        op_id: update.opId ?? null,
        session_id: update.sessionId ?? null,
      }),
    ),
    events: events.map((event: Record<string, unknown>) => ({
      seq: event.seq,
      type: event.type,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      actor: event.actor,
      session_id: event.sessionId,
      payload: event.payload,
      at: event.at,
      op_id: event.opId,
    })),
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

export function createAyanamiToolRegistry(service: AyanamiTaskService): ToolDefinitionRegistry {
  const registry = new ToolDefinitionRegistry();
  const defineTool = <Input extends z.ZodType>(
    profile: AyanamiToolProfile,
    name: string,
    config: DefineToolConfig<Input>,
    handler: ToolCallback<Input>,
  ): void => {
    const wrapped = (async (input: z.output<Input>, extra: Parameters<typeof handler>[1]) => {
      const record = input as Record<string, unknown>;
      const project =
        typeof record.project === "string"
          ? record.project
          : typeof record.project_code === "string"
            ? record.project_code
            : undefined;
      return await withMcpErrorDetails(
        service,
        project === undefined ? {} : { project },
        async () => await handler(input, extra),
      );
    }) as ToolCallback<Input>;
    registry.define(profile, name, config, wrapped);
  };

  defineTool(
    "core",
    "atm_begin",
    {
      description: "直接使用返回的 brief",
      inputSchema: beginToolInput,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      const { brief, ...externalInput } = input;
      const canonical = beginExternal.parse(externalInput);
      const beginInput = Object.fromEntries(
        Object.entries(canonical).filter(([, value]) => value !== undefined),
      ) as Parameters<AyanamiTaskService["begin"]>[0];
      const briefMode = z.enum(["none", "minimal", "full"]).parse(brief);
      const started = await withMcpErrorDetails(
        service,
        canonical.projectCode === undefined ? {} : { project: canonical.projectCode },
        () => service.begin(beginInput),
      );
      if (started.scope === "quick") {
        return result(
          {
            scope: "quick",
            quick: started.quick.key,
            status: started.quick.status,
            version: started.quick.version,
            surface_version: MCP_SURFACE_VERSION,
            ...(canonical.operationId === undefined ? {} : { op_id: canonical.operationId }),
          },
          1200,
        );
      }
      const snapshot = await service.briefSnapshot(
        String(started.project),
        String(started.session),
      );
      const recordSnapshot =
        briefMode === "full"
          ? await captureBriefRecordSnapshot(service, String(started.project), snapshot)
          : [];
      const { score: _classificationScore, ...beginIdentity } = started;
      void _classificationScore;
      return wrap(
        fitBegin({ ...beginIdentity, ...snapshot }, briefMode, canonical.maxChars, recordSnapshot),
      );
    },
  );

  defineTool(
    "core",
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
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      const decodedCursor = input.cursor === undefined ? null : decodeBriefCursor(input.cursor);
      if (decodedCursor) {
        validateBriefCursorRequest(decodedCursor, {
          project: input.project_code,
          ...(input.session_id === undefined ? {} : { sessionId: input.session_id }),
          include: input.include,
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
      const frozenRecords = decodedCursor
        ? await resolveBriefRecordSnapshot(service, input.project_code, decodedCursor, brief)
        : null;
      const recordSnapshot = decodedCursor
        ? undefined
        : wanted("records")
          ? await captureBriefRecordSnapshot(service, input.project_code, brief)
          : [];
      const fitInput = {
        payload,
        include: input.include,
        maxChars: input.max_chars,
        project: input.project_code,
        ...(input.session_id === undefined ? {} : { sessionId: input.session_id }),
        ...(input.task_key === undefined ? {} : { taskKey: input.task_key }),
        ...(input.since_seq === undefined ? {} : { sinceSeq: input.since_seq }),
        ...(recordSnapshot === undefined ? {} : { recordSnapshot }),
      };
      return wrap(
        decodedCursor
          ? continueWholeBrief(decodedCursor, fitInput, frozenRecords ?? [])
          : fitWholeBrief({
              ...fitInput,
              identity: input.session_id === undefined ? {} : { session_id: input.session_id },
            }),
      );
    },
  );

  defineTool(
    "core",
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
      annotations: { readOnlyHint: true, destructiveHint: false },
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
      const items = await service.listWorkItems(input.project, filters, projectionView);
      const projectedItems = items.map((item) =>
        selectFields(externalizeTaskView(item) as Record<string, unknown>, input.field_mask),
      );
      const sourceHasMore =
        items.length === input.limit &&
        (
          await service.listWorkItems(
            input.project,
            {
              ...filters,
              limit: 1,
              offset: offset + items.length,
            },
            "core",
          )
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

  defineTool(
    "core",
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
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      const item = await service.getWorkItem(input.project, input.task_key, input.view);
      const externalItem = externalizeTaskView(item) as Record<string, unknown>;
      const projected = selectFields(externalItem, input.field_mask);
      return wrap(
        fitFieldRead(
          projected,
          input.max_chars,
          "atm_task_get",
          {
            project: input.project,
            entity: input.task_key,
            entityType: "WORK_ITEM",
            fieldMask: [`@view:${input.view}`, ...input.field_mask],
            targetVersion: fieldTargetVersion(externalItem),
          },
          input.cursor,
        ),
      );
    },
  );

  defineTool(
    "core",
    "atm_task_create",
    {
      description: "批量创建任务与关系。",
      inputSchema: taskCreateExternal.inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      const canonical = taskCreateExternal.parse(input);
      const canonicalItems = canonical.items.map((item) =>
        Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)),
      ) as Parameters<AyanamiTaskService["createWorkItems"]>[3];
      const created = await service.createWorkItems(
        canonical.project,
        canonical.session,
        canonical.opId,
        canonicalItems,
        { resolvePlanningRoot: true },
      );
      return wrap(
        mutationAck(
          canonical.project,
          canonical.session,
          canonical.opId,
          "work.create.batch",
          created as unknown as Record<string, unknown>,
        ),
      );
    },
  );

  defineTool(
    "actions",
    "atm_task_patch",
    {
      description: "批量变更任务。",
      inputSchema: taskPatchToolInput,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (input) => {
      const operation = input.items[0]!.operation as TaskPatchOperation;
      if (operation === "review_request") {
        const item = canonicalTaskPatchItem(input.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "review_request" }
        >;
        const created = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            taskKey: item.taskKey,
            checklistId: item.parentChecklistId,
            expectedVersion: item.expectedParentChecklistVersion,
            expectedVersions: { [item.taskKey]: item.expectedVersion },
          },
          () =>
            service.createReviewRequest(input.project, input.session, input.op_id, {
              reviewTaskKey: item.taskKey,
              expectedReviewTaskVersion: item.expectedVersion,
              parentChecklistId: item.parentChecklistId,
              expectedParentChecklistVersion: item.expectedParentChecklistVersion,
              expectedCandidateHashes: item.candidateHashes,
            }),
        );
        return wrap(
          mutationAck(
            input.project,
            input.session,
            input.op_id,
            "review.request.create",
            created as unknown as Record<string, unknown>,
          ),
        );
      }
      if (operation === "review_submit") {
        const item = canonicalTaskPatchItem(input.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "review_submit" }
        >;
        const request = await service.getReviewRequest(input.project, item.requestKey);
        if (request.reviewTaskKey !== item.taskKey) {
          throw new AtmError("REVIEW_BINDING_MISMATCH", {
            message: `Review 绑定不匹配：${item.taskKey}`,
            details: { task_key: item.taskKey },
          });
        }
        const submitted = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            taskKey: item.taskKey,
            checklistId: request.parentChecklistId,
            expectedVersion: request.parentChecklistVersion,
            expectedVersions: { [item.taskKey]: item.expectedVersion },
          },
          () =>
            service.submitReview(input.project, input.session, input.op_id, {
              requestKey: item.requestKey,
              expectedReviewTaskVersion: item.expectedVersion,
              verdict: item.verdict,
              reviewedHashes: item.candidateHashes,
              evidence: item.evidence,
            }),
        );
        return wrap(
          mutationAck(
            input.project,
            input.session,
            input.op_id,
            "review.submit",
            submitted as unknown as Record<string, unknown>,
          ),
        );
      }
      if (operation === "verify_and_complete") {
        const item = canonicalTaskPatchItem(input.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "verify_and_complete" }
        >;
        const completed = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            taskKey: item.taskKey,
            expectedVersion: item.expectedVersion,
          },
          () =>
            service.verifyAndComplete(input.project, input.session, input.op_id, {
              taskKey: item.taskKey,
              expectedVersion: item.expectedVersion,
            }),
        );
        return wrap(
          mutationAck(
            input.project,
            input.session,
            input.op_id,
            "work.verify-and-complete",
            completed as unknown as Record<string, unknown>,
          ),
        );
      }
      if (operation === "checklist_batch") {
        const item = canonicalTaskPatchItem(input.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "checklist_batch" }
        >;
        const updated = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            taskKey: item.taskKey,
            expectedVersion: item.expectedVersion,
          },
          () =>
            service.updateChecklistBatch(input.project, input.session, input.op_id, {
              taskKey: item.taskKey,
              expectedVersion: item.expectedVersion,
              items: item.checklistItems.map((checklistItem) => ({
                checklistId: checklistItem.checklistId,
                status: checklistItem.status,
                ...(checklistItem.evidence === undefined
                  ? {}
                  : { evidence: checklistItem.evidence }),
              })),
            }),
        );
        return wrap(
          mutationAck(
            input.project,
            input.session,
            input.op_id,
            "checklist.update.batch",
            updated as unknown as Record<string, unknown>,
          ),
        );
      }
      if (operation === "checklist_single") {
        const item = canonicalTaskPatchItem(input.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "checklist_single" }
        >;
        const checklistItem = item.checklistItems[0]!;
        const updated = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            checklistId: checklistItem.checklistId,
            expectedVersion: item.expectedVersion,
          },
          () =>
            service.updateChecklist(input.project, input.session, input.op_id, {
              checklistId: checklistItem.checklistId,
              expectedVersion: item.expectedVersion,
              status: checklistItem.status,
              ...(checklistItem.evidence === undefined ? {} : { evidence: checklistItem.evidence }),
            }),
        );
        return wrap(
          mutationAck(input.project, input.session, input.op_id, "checklist.update", {
            ...(updated as unknown as Record<string, unknown>),
            taskKey: item.taskKey,
          }),
        );
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
            input.items.map((item) => canonicalTaskPatchItem(item) as any),
          ),
      );
      return wrap(
        mutationAck(
          input.project,
          input.session,
          input.op_id,
          "work.patch.batch",
          patched as unknown as Record<string, unknown>,
        ),
      );
    },
  );

  defineTool(
    "memory",
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
      annotations: { readOnlyHint: false, destructiveHint: false },
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
        return wrap(
          mutationAck(
            input.project,
            input.session,
            input.op_id,
            "project-update.publish",
            update as unknown as Record<string, unknown>,
          ),
        );
      }
      if (!input.task_key)
        throw new AtmError("VALIDATION_ERROR", { message: "task scope 要求 task_key" });
      const updated = await service.addProgress(input.project, input.session, input.op_id, {
        taskKey: input.task_key,
        summary: input.summary,
        completed,
        next: input.next,
        evidence: input.evidence,
        ...(input.percent === undefined ? {} : { percent: input.percent }),
        ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
      });
      return wrap(
        mutationAck(
          input.project,
          input.session,
          input.op_id,
          "work.progress",
          updated as unknown as Record<string, unknown>,
        ),
      );
    },
  );

  defineTool(
    "memory",
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
      annotations: { readOnlyHint: false, destructiveHint: false },
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
      return wrap(
        mutationAck(
          input.project,
          input.session,
          input.op_id,
          "record.create",
          created as unknown as Record<string, unknown>,
        ),
      );
    },
  );

  defineTool(
    "memory",
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
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      if (input.op_id !== undefined) {
        if (!input.project)
          throw new AtmError("PROJECT_REQUIRED", { message: "op_id 精确回查要求 project" });
        const trace = compactOperationTrace(
          plain(await service.getOperationTrace(input.project, input.op_id, input.session)),
        );
        const source = selectFields(trace, input.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, input.max_chars - 80),
          "atm_search",
          {
            project: input.project,
            entity: `${input.op_id}@${input.session ?? "*"}`,
            entityType: "OPERATION",
            fieldMask: input.field_mask,
            targetVersion: fieldTargetVersion(trace),
          },
          input.cursor,
        );
        return wrap({ exact: true, entity_type: "OPERATION", operation: fitted });
      }
      if (!input.query)
        throw new AtmError("VALIDATION_ERROR", { message: "query 或 op_id 至少提供一个" });
      if (input.query.startsWith("op:")) {
        if (!input.project)
          throw new AtmError("PROJECT_REQUIRED", { message: "op_id 精确回查要求 project" });
        const exactOpId = input.query.slice(3).trim();
        if (!exactOpId) throw new AtmError("VALIDATION_ERROR", { message: "op: 后必须提供 op_id" });
        const trace = compactOperationTrace(
          plain(await service.getOperationTrace(input.project, opId.parse(exactOpId))),
        );
        const source = selectFields(trace, input.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, input.max_chars - 80),
          "atm_search",
          {
            project: input.project,
            entity: `${exactOpId}@*`,
            entityType: "OPERATION",
            fieldMask: input.field_mask,
            targetVersion: fieldTargetVersion(trace),
          },
          input.cursor,
        );
        return wrap({ exact: true, entity_type: "OPERATION", operation: fitted });
      }
      const scopedEntity = scopedUlidQuery(input.query);
      if (scopedEntity) {
        if (!input.project) {
          throw new AtmError("PROJECT_REQUIRED", {
            message: `${scopedEntity.kind.toLowerCase()} 精确读取要求 project`,
          });
        }
        const entity =
          scopedEntity.kind === "PROGRESS"
            ? compactProgress(
                plain(await service.getProgressUpdate(input.project, scopedEntity.id)),
              )
            : compactSession(plain(await service.getSession(input.project, scopedEntity.id)));
        const source = selectFields(entity, input.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, input.max_chars - 80),
          "atm_search",
          {
            project: input.project,
            entity: scopedEntity.id,
            entityType: scopedEntity.kind,
            fieldMask: input.field_mask,
            targetVersion: fieldTargetVersion(entity),
          },
          input.cursor,
        );
        return wrap({ exact: true, entity_type: scopedEntity.kind, entity: fitted });
      }
      const kind = publicKeyKind(input.query);
      const exactProject = input.project ?? projectFromPublicKey(input.query) ?? undefined;
      if (kind && exactProject) {
        const entity = plain(
          kind === "WORK_ITEM"
            ? await service.getWorkItem(exactProject, input.query, "full")
            : compactRecord(plain(await service.getRecord(exactProject, input.query))),
        );
        const source = selectFields(entity, input.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, input.max_chars - 80),
          "atm_search",
          {
            project: exactProject,
            entity: input.query.toUpperCase(),
            entityType: kind,
            fieldMask: input.field_mask,
            targetVersion: fieldTargetVersion(entity),
          },
          input.cursor,
        );
        return wrap({
          exact: true,
          entity_type: kind,
          entity: fitted,
        });
      }

      const searchQuery = input.query;
      const fetchPage = (limit: number) =>
        input.project
          ? service.search(input.project, searchQuery, limit, input.cursor)
          : service.globalSearch(searchQuery, limit, input.cursor);
      const initial = (await fetchPage(input.limit)) as SearchServicePage;
      return wrap(
        await fitSearchPage({
          initial,
          fetchPage,
          requestedLimit: input.limit,
          ...(input.cursor === undefined ? {} : { inputCursor: input.cursor }),
          fieldMask: input.field_mask,
          maxChars: input.max_chars,
        }),
      );
    },
  );

  defineTool(
    "memory",
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
      annotations: { readOnlyHint: true, destructiveHint: false },
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

  defineTool(
    "core",
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
      annotations: { readOnlyHint: false, destructiveHint: false },
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
      return wrap(
        mutationAck(
          input.project,
          input.session,
          input.op_id,
          "session.end",
          ended as unknown as Record<string, unknown>,
        ),
      );
    },
  );

  return registry;
}

export function createAyanamiMcpServer(
  service: AyanamiTaskService,
  options: { profile?: AyanamiMcpProfile } = {},
): Server {
  const profile = options.profile ?? "core";
  const server = new Server(
    { name: "ayanami-task-manager", version: "1.0.18" },
    {
      capabilities: { tools: {} },
      instructions:
        profile === "legacy"
          ? "MCP surface v3 · legacy 兼容入口为尚未重启的旧 Agent 会话保留完整 11 工具。请重启 Agent 客户端以重新加载已自动迁移的 core / memory / actions 三 Profile 配置；若仍只看到本入口，请在 ATM 设置中重新安装对应 Agent 集成。"
          : profile === "core"
            ? "MCP surface v3 · core profile。开工调用一次 atm_begin 并直接使用返回的 brief；不要紧接 atm_brief。仅在上下文压缩、长时间离开或明确恢复 working set 时调用 atm_brief。task_list/task_get 按需，结束调用 atm_end。"
            : profile === "memory"
              ? "MCP surface v3 · memory profile。Session 由 core profile 建立；本 profile 负责进度、长期记录、搜索与增量读取。"
              : "MCP surface v3 · actions profile。Session 由 core profile 建立；本 profile 只负责 atm_task_patch 的 16 类规范化任务操作。",
    },
  );
  registerPublishedToolHandlers(
    server,
    createAyanamiToolRegistry(service),
    profile,
    MCP_SURFACE_VERSION,
  );
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
