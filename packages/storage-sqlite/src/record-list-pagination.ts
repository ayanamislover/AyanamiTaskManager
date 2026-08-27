import { createHash, timingSafeEqual } from "node:crypto";
import { AtmError, isAtmError } from "@ayanami-task/errors";

export type RecordListSelection = { list: "records" };
export type RecordListPosition = { updatedAt: string; localNo: number };

type RecordListCursorPayload = {
  v: 1;
  p: string;
  s: string;
  l: { u: string; n: number } | null;
};

const CURSOR_PREFIX = "rl1";

function selectionHash(selection: RecordListSelection): string {
  return createHash("sha256")
    .update(JSON.stringify([selection.list]), "utf8")
    .digest("base64url")
    .slice(0, 22);
}

function digest(body: string): string {
  return createHash("sha256")
    .update(`${CURSOR_PREFIX}:${body}:ayanami-record-list`, "utf8")
    .digest("base64url")
    .slice(0, 22);
}

function invalidCursor(): never {
  throw new AtmError("INVALID_CURSOR", {
    message: "record list cursor 无效、已损坏或不属于当前选择集",
    details: {
      reason: "INVALID_OR_TAMPERED",
      recovery: { action: "restart_read", omit_cursor: true },
    },
  });
}

export function encodeRecordListCursor(input: {
  project: string;
  selection: RecordListSelection;
  last: RecordListPosition | null;
}): string {
  const payload: RecordListCursorPayload = {
    v: 1,
    p: input.project.toUpperCase(),
    s: selectionHash(input.selection),
    l: input.last ? { u: input.last.updatedAt, n: input.last.localNo } : null,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${CURSOR_PREFIX}.${body}.${digest(body)}`;
}

export function decodeRecordListCursor(
  token: string,
  input: { project: string; selection: RecordListSelection },
): { last: RecordListPosition | null } {
  try {
    const [prefix, body, signature, extra] = token.split(".");
    if (prefix !== CURSOR_PREFIX || !body || !signature || extra !== undefined) invalidCursor();
    const actual = Buffer.from(signature, "utf8");
    const expected = Buffer.from(digest(body), "utf8");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) invalidCursor();
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<RecordListCursorPayload>;
    const last = payload.l;
    if (
      Object.keys(payload).sort().join(",") !== "l,p,s,v" ||
      payload.v !== 1 ||
      payload.p !== input.project.toUpperCase() ||
      payload.s !== selectionHash(input.selection) ||
      (last !== null &&
        (!last ||
          Object.keys(last).sort().join(",") !== "n,u" ||
          typeof last.u !== "string" ||
          last.u.length === 0 ||
          !Number.isSafeInteger(last.n) ||
          last.n <= 0))
    ) {
      invalidCursor();
    }
    return { last: last === null ? null : { updatedAt: last!.u, localNo: last!.n } };
  } catch (error) {
    if (isAtmError(error) && error.code === "INVALID_CURSOR") throw error;
    return invalidCursor();
  }
}
