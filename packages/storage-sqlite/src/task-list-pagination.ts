import { createHash, timingSafeEqual } from "node:crypto";
import { AtmError, isAtmError } from "@ayanami-task/errors";

export type TaskListSelection = {
  status: string | null;
  owner: string | null;
  parent: string | null;
  milestone: string | null;
  ready: boolean;
  query: string | null;
};

export type TaskListPosition = {
  priorityRank: number;
  sortKey: number;
  createdAt: string;
  localNo: number;
};

type TaskListCursorPayload = {
  v: 1;
  p: string;
  s: string;
  l: { r: number; k: number; c: string; n: number } | null;
};

const CURSOR_PREFIX = "tl1";

function normalizeText(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFC");
  return normalized.length === 0 ? null : normalized;
}

export function canonicalTaskListSelection(input: TaskListSelection): TaskListSelection {
  return {
    status: normalizeText(input.status),
    owner: normalizeText(input.owner),
    parent: normalizeText(input.parent),
    milestone: normalizeText(input.milestone),
    ready: input.ready,
    query: normalizeText(input.query),
  };
}

function selectionHash(input: TaskListSelection): string {
  const selection = canonicalTaskListSelection(input);
  return createHash("sha256")
    .update(
      JSON.stringify([
        selection.status,
        selection.owner,
        selection.parent,
        selection.milestone,
        selection.ready,
        selection.query,
      ]),
      "utf8",
    )
    .digest("base64url")
    .slice(0, 22);
}

function digest(body: string): string {
  // Deterministic integrity check only; this cursor is not an authorization token.
  return createHash("sha256")
    .update(`${CURSOR_PREFIX}:${body}:ayanami-task-list`, "utf8")
    .digest("base64url")
    .slice(0, 22);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function invalidCursor(): never {
  throw new AtmError("INVALID_CURSOR", {
    message: "task list cursor 无效、已损坏或不属于当前选择集",
    details: {
      reason: "INVALID_OR_TAMPERED",
      recovery: { action: "restart_read", omit_cursor: true },
    },
  });
}

function validPosition(value: unknown): value is NonNullable<TaskListCursorPayload["l"]> {
  if (!value || typeof value !== "object") return false;
  const position = value as Record<string, unknown>;
  return (
    Object.keys(position).sort().join(",") === "c,k,n,r" &&
    Number.isSafeInteger(position.r) &&
    Number(position.r) >= 0 &&
    Number(position.r) <= 3 &&
    Number.isSafeInteger(position.k) &&
    typeof position.c === "string" &&
    position.c.length > 0 &&
    Number.isSafeInteger(position.n) &&
    Number(position.n) > 0
  );
}

export function encodeTaskListCursor(input: {
  project: string;
  selection: TaskListSelection;
  last: TaskListPosition | null;
}): string {
  const payload: TaskListCursorPayload = {
    v: 1,
    p: input.project.toUpperCase(),
    s: selectionHash(input.selection),
    l: input.last
      ? {
          r: input.last.priorityRank,
          k: input.last.sortKey,
          c: input.last.createdAt,
          n: input.last.localNo,
        }
      : null,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${CURSOR_PREFIX}.${body}.${digest(body)}`;
}

export function decodeTaskListCursor(
  token: string,
  input: { project: string; selection: TaskListSelection },
): { last: TaskListPosition | null } {
  try {
    const [prefix, body, signature, extra] = token.split(".");
    if (prefix !== CURSOR_PREFIX || !body || !signature || extra !== undefined) invalidCursor();
    if (!safeEqual(signature, digest(body))) invalidCursor();
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<TaskListCursorPayload>;
    if (
      Object.keys(payload).sort().join(",") !== "l,p,s,v" ||
      payload.v !== 1 ||
      payload.p !== input.project.toUpperCase() ||
      payload.s !== selectionHash(input.selection) ||
      (payload.l !== null && !validPosition(payload.l))
    ) {
      invalidCursor();
    }
    return {
      last:
        payload.l === null
          ? null
          : {
              priorityRank: payload.l!.r,
              sortKey: payload.l!.k,
              createdAt: payload.l!.c,
              localNo: payload.l!.n,
            },
    };
  } catch (error) {
    if (isAtmError(error) && error.code === "INVALID_CURSOR") throw error;
    return invalidCursor();
  }
}
