import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { AtmError } from "@ayanami-task/errors";
import { plain } from "../result.js";

// brief 的分节名 -> 载荷字段。truncated/project/seq 是身份字段，任何 include 都保留。
export const briefSections = {
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
export type BriefSection = keyof typeof briefSections;
export const briefSectionNames = Object.keys(briefSections) as [BriefSection, ...BriefSection[]];
export const briefAlwaysKeys: readonly string[] = ["truncated", "project", "seq"];
const BRIEF_CURSOR_TTL_MS = 30 * 60 * 1000;
const BRIEF_CURSOR_PREFIX = "b2";
const BRIEF_CURSOR_HASH_DOMAIN = "AYANAMI_TASK_MANAGER_BRIEF_CURSOR_V2\0";

// include 为空表示全要；非空时只保留被点名的分节。
export function pickBriefSections(
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
export function compactBriefTask(value: unknown): Record<string, unknown> {
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
export const briefDropOrder: readonly BriefSection[] = [
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

export type BriefRecordSnapshot = readonly [key: string, version: string];

export type BriefCursor = {
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

export async function captureBriefRecordSnapshot(
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

export async function resolveBriefRecordSnapshot(
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

export function encodeBriefCursor(cursor: BriefCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  const signature = createHash("sha256")
    .update(BRIEF_CURSOR_HASH_DOMAIN, "utf8")
    .update(payload, "utf8")
    .digest()
    .subarray(0, 16)
    .toString("base64url");
  return `${BRIEF_CURSOR_PREFIX}.${payload}.${signature}`;
}

export function decodeBriefCursor(token: string): BriefCursor {
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

export function makeBriefCursor(input: {
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

export function validateBriefCursorRequest(
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
