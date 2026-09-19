import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { AtmError } from "@ayanami-task/errors";
import { bounded } from "../result.js";

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

export function fieldTargetVersion(value: Record<string, unknown>): string {
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

/**
 * field_mask 里这个 view 根本给不出的字段。
 *
 * selectFields 会把它们静默丢掉，于是 `field_mask: ["status","title"]` 在 core view 下
 * 只回 status，调用方看到的是「这个任务没有 title」，而不是「你要的字段这个 view 没有」。
 * 实测代价是换 view 再 get 一次。field_mask 是「在 view 已有的字段内过滤」，不是「我要这些字段」，
 * 这件事得由响应自己讲出来。
 */
export function ignoredFields(
  value: Record<string, unknown>,
  fieldMask: readonly string[],
): string[] {
  if (fieldMask.length === 0 || fieldMask.includes("*")) return [];
  return fieldMask.filter((field) => !(field in value));
}

/**
 * 把 ignored_fields 回显裁到调用方给的预算之内，并报出它实际要占的字符数。
 *
 * 头一版两头都放宽：先从 max_chars 里扣掉回显开销，又用 Math.max 把正文预算夹回 300/500，
 * 最后无条件把完整回显贴回响应。于是 `max_chars=300` 配 30 个合法长度的越界字段，实际返回
 * 1910 字符——对靠 max_chars 控上下文的调用方，这是可观察的契约违背，而且它并没有做错什么。
 *
 * 现在回显自己先按预算裁剪：列不下的名字换成一个计数，调用方仍然知道还有多少没列出来。
 * 回显最多占一半预算，另一半留给正文，正文的兜底回执再小也装得下——不依赖各个 fitter
 * 内部的最小尺寸，那些数字会随实现漂。
 */
export function fitIgnoredFields(
  ignored: readonly string[],
  maxChars: number,
): { echo: Record<string, unknown>; cost: number } {
  if (ignored.length === 0) return { echo: {}, cost: 0 };
  const budget = Math.floor(maxChars / 2);
  for (let kept = ignored.length; kept >= 0; kept -= 1) {
    const omitted = ignored.length - kept;
    const echo: Record<string, unknown> = {
      ignored_fields: ignored.slice(0, kept),
      ...(omitted === 0 ? {} : { ignored_fields_omitted: omitted }),
    };
    // JSON.stringify 单独算这个对象会把两个花括号也算进去，而合并进正文时只多一个逗号，
    // 所以这里恒多留 1 个字符。宁可多留，不可少留。
    const cost = JSON.stringify(echo).length;
    if (cost <= budget) return { echo, cost };
  }
  return { echo: {}, cost: 0 };
}

export function selectFields(
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

export function fitFieldRead(
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
