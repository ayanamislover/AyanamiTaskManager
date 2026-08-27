import { createHash, timingSafeEqual } from "node:crypto";
import { AtmError, isAtmError } from "@ayanami-task/errors";

export type SessionListSelection = { list: "sessions" };
export type SessionListPosition = { startedAt: string; id: string };

type SessionListCursorPayload = {
  v: 1;
  p: string;
  s: string;
  l: { t: string; i: string } | null;
};

const CURSOR_PREFIX = "sl1";

function selectionHash(selection: SessionListSelection): string {
  return createHash("sha256")
    .update(JSON.stringify([selection.list]), "utf8")
    .digest("base64url")
    .slice(0, 22);
}

function digest(body: string): string {
  // Deterministic integrity check only; this cursor is not an authorization token.
  return createHash("sha256")
    .update(`${CURSOR_PREFIX}:${body}:ayanami-session-list`, "utf8")
    .digest("base64url")
    .slice(0, 22);
}

function invalidCursor(): never {
  throw new AtmError("INVALID_CURSOR", {
    message: "session list cursor 无效、已损坏或不属于当前选择集",
    details: {
      reason: "INVALID_OR_TAMPERED",
      recovery: { action: "restart_read", omit_cursor: true },
    },
  });
}

function validPosition(value: unknown): value is NonNullable<SessionListCursorPayload["l"]> {
  if (!value || typeof value !== "object") return false;
  const position = value as Record<string, unknown>;
  return (
    Object.keys(position).sort().join(",") === "i,t" &&
    typeof position.t === "string" &&
    position.t.length > 0 &&
    typeof position.i === "string" &&
    position.i.length > 0
  );
}

export function encodeSessionListCursor(input: {
  project: string;
  selection: SessionListSelection;
  last: SessionListPosition | null;
}): string {
  const payload: SessionListCursorPayload = {
    v: 1,
    p: input.project.toUpperCase(),
    s: selectionHash(input.selection),
    l: input.last ? { t: input.last.startedAt, i: input.last.id } : null,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${CURSOR_PREFIX}.${body}.${digest(body)}`;
}

export function decodeSessionListCursor(
  token: string,
  input: { project: string; selection: SessionListSelection },
): { last: SessionListPosition | null } {
  try {
    const [prefix, body, signature, extra] = token.split(".");
    if (prefix !== CURSOR_PREFIX || !body || !signature || extra !== undefined) invalidCursor();
    const actual = Buffer.from(signature, "utf8");
    const expected = Buffer.from(digest(body), "utf8");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) invalidCursor();
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<SessionListCursorPayload>;
    const last = payload.l;
    if (
      Object.keys(payload).sort().join(",") !== "l,p,s,v" ||
      payload.v !== 1 ||
      payload.p !== input.project.toUpperCase() ||
      payload.s !== selectionHash(input.selection) ||
      (last !== null && !validPosition(last))
    ) {
      invalidCursor();
    }
    return {
      last: last === null ? null : { startedAt: last!.t, id: last!.i },
    };
  } catch (error) {
    if (isAtmError(error) && error.code === "INVALID_CURSOR") throw error;
    return invalidCursor();
  }
}
