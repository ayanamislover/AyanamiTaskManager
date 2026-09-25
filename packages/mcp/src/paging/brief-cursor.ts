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
const BRIEF_CURSOR_PREFIX = "b3";
const BRIEF_CURSOR_HASH_DOMAIN = "AYANAMI_TASK_MANAGER_BRIEF_CURSOR_V3\0";

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
//
// records 排在 own / counts / objective / next 之前：它是唯一能沿 continuation 续读的分节，
// 让位之后一条不丢；那几个分节加起来才几十到一两百字符，丢了却再也拿不回来。
// 旧顺序在默认预算下先把它们全丢光，只剩一条 Record 和一个放不下的游标（ATM-T-0405）。
export const briefDropOrder: readonly BriefSection[] = [
  "artifacts",
  "records",
  "own",
  "counts",
  "objective",
  "next",
  "progress",
  "delta",
  "task",
  "current",
  "handoff",
];

export type BriefRecordSnapshot = readonly [key: string, version: string];

export type BriefCursor = {
  v: 3;
  t: string;
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
  return briefHash(record, 6);
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
    source_type: record.sourceType ?? record.source_type,
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
  for (const [shortKey, expectedVersion] of cursor.r) {
    const key = fullRecordKey(project, shortKey);
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

// v3 线格式：`b3.<target>.<offset>.<seq>.<expiry>.<records>.<signature>`，全部是
// base64url / 十进制 / key 字符，不再整体 JSON + base64。v2 在 8 条 Record 时约 560 字符，
// 默认预算下连游标都放不下，brief 只好退化成 continuation_omitted（ATM-T-0405）。
// 项目、Session、include 与查询参数只以一个 target 哈希出现：续读请求本来就要重传它们，
// 游标只需证明两次请求指向同一目标。Record key 省去 `<项目>-` 前缀，版本取 6 字节摘要。
const RECORD_KEY_PATTERN = /^[A-Z0-9][A-Z0-9-]*$/u;
const RECORD_VERSION_PATTERN = /^[A-Za-z0-9_-]{8}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,15})$/u;

function briefSignature(body: string): Buffer {
  return createHash("sha256")
    .update(BRIEF_CURSOR_HASH_DOMAIN, "utf8")
    .update(body, "utf8")
    .digest()
    .subarray(0, 16);
}

export function encodeBriefCursor(cursor: BriefCursor): string {
  const records = cursor.r.map(([key, version]) => `${key}:${version}`).join(",");
  const body = [BRIEF_CURSOR_PREFIX, cursor.t, cursor.o, cursor.n, cursor.e, records].join(".");
  return `${body}.${briefSignature(body).toString("base64url")}`;
}

function decimal(value: string | undefined): number {
  if (value === undefined || !DECIMAL_PATTERN.test(value)) throw new Error("shape");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("shape");
  return parsed;
}

export function decodeBriefCursor(token: string): BriefCursor {
  const expired = Symbol("brief-cursor-expired");
  try {
    const parts = token.split(".");
    if (parts.length !== 7 || parts[0] !== BRIEF_CURSOR_PREFIX) throw new Error("shape");
    const [, target, offset, seq, expiry, records, signature] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const expected = briefSignature(parts.slice(0, 6).join("."));
    const received = Buffer.from(signature, "base64url");
    if (
      received.toString("base64url") !== signature ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      throw new Error("signature");
    }
    const r = records.split(",").map((entry) => {
      const [key, version, extra] = entry.split(":");
      if (
        extra !== undefined ||
        !key ||
        !version ||
        !RECORD_KEY_PATTERN.test(key) ||
        !RECORD_VERSION_PATTERN.test(version)
      ) {
        throw new Error("shape");
      }
      return [key, version] as const;
    });
    const value: BriefCursor = {
      v: 3,
      t: target,
      o: decimal(offset),
      r,
      n: decimal(seq),
      e: decimal(expiry),
    };
    if (
      !/^[A-Za-z0-9_-]{11}$/u.test(value.t) ||
      r.length > 8 ||
      value.o > r.length ||
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

type BriefTarget = {
  project: string;
  sessionId?: string;
  include: readonly BriefSection[];
  taskKey?: string;
  sinceSeq?: number;
};

function briefTargetHash(input: BriefTarget): string {
  return briefHash(
    [
      input.project.toUpperCase(),
      input.sessionId ?? "",
      briefIncludeMask(input.include),
      input.taskKey ?? null,
      input.sinceSeq ?? null,
    ],
    8,
  );
}

function shortRecordKey(project: string, key: string): string {
  const prefix = `${project.toUpperCase()}-`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/** 游标里的 key 省去了项目前缀；`R-12` 这种形状只可能是省略过的。 */
export function fullRecordKey(project: string, key: string): string {
  return /^[A-Z]-\d+$/u.test(key) ? `${project.toUpperCase()}-${key}` : key;
}

export function makeBriefCursor(
  input: BriefTarget & {
    offset: number;
    recordSnapshot: BriefRecordSnapshot[];
    snapshotSeq: number;
  },
): string {
  return encodeBriefCursor({
    v: 3,
    t: briefTargetHash(input),
    o: input.offset,
    r: input.recordSnapshot.map(([key, version]) => [shortRecordKey(input.project, key), version]),
    n: input.snapshotSeq,
    e: briefCursorExpiry(),
  });
}

export function validateBriefCursorRequest(cursor: BriefCursor, input: BriefTarget): void {
  if (cursor.t !== briefTargetHash(input)) {
    throw new AtmError("CONTINUATION_CONFLICT", {
      message: "brief continuation 请求身份已变化",
      details: {
        reason: "TARGET_MISMATCH",
        recovery: { action: "retry_original_target", preserve_cursor: true },
      },
    });
  }
}
