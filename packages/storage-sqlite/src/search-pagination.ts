import { createHash, timingSafeEqual } from "node:crypto";

export type SearchPosition = {
  updatedAt: string;
  project: string;
  entityType: string;
  entityKey: string;
};

export type SearchSnapshot = {
  documents: number;
  quickTasks: number;
};

export type SearchCursorState = {
  snapshot: SearchSnapshot;
  last: SearchPosition;
};

type SearchCursorPayload = {
  v: 1;
  s: string;
  q: string;
  d: number;
  k: number;
  u: string;
  p: string;
  t: string;
  e: string;
};

const CURSOR_PREFIX = "s1";

function queryHash(query: string): string {
  return createHash("sha256")
    .update(query.trim().normalize("NFC"), "utf8")
    .digest("base64url")
    .slice(0, 22);
}

function digest(body: string): string {
  return createHash("sha256")
    .update(`${CURSOR_PREFIX}:${body}:ayanami-task-search`, "utf8")
    .digest("base64url")
    .slice(0, 22);
}

function invalidCursor(): never {
  throw new Error("INVALID_CURSOR: search cursor 无效、已损坏或不属于当前查询");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function encodeSearchCursor(input: {
  scope: string;
  query: string;
  snapshot: SearchSnapshot;
  last: SearchPosition;
}): string {
  const payload: SearchCursorPayload = {
    v: 1,
    s: input.scope.toUpperCase(),
    q: queryHash(input.query),
    d: input.snapshot.documents,
    k: input.snapshot.quickTasks,
    u: input.last.updatedAt,
    p: input.last.project,
    t: input.last.entityType,
    e: input.last.entityKey,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${CURSOR_PREFIX}.${body}.${digest(body)}`;
}

export function decodeSearchCursor(
  token: string,
  input: { scope: string; query: string },
): SearchCursorState {
  try {
    const [prefix, body, signature, extra] = token.split(".");
    if (prefix !== CURSOR_PREFIX || !body || !signature || extra !== undefined) invalidCursor();
    if (!safeEqual(signature, digest(body))) invalidCursor();
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<SearchCursorPayload>;
    if (
      payload.v !== 1 ||
      payload.s !== input.scope.toUpperCase() ||
      payload.q !== queryHash(input.query) ||
      !Number.isSafeInteger(payload.d) ||
      Number(payload.d) < 0 ||
      !Number.isSafeInteger(payload.k) ||
      Number(payload.k) < 0 ||
      typeof payload.u !== "string" ||
      typeof payload.p !== "string" ||
      typeof payload.t !== "string" ||
      typeof payload.e !== "string"
    ) {
      invalidCursor();
    }
    return {
      snapshot: { documents: Number(payload.d), quickTasks: Number(payload.k) },
      last: {
        updatedAt: payload.u,
        project: payload.p,
        entityType: payload.t,
        entityKey: payload.e,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("INVALID_CURSOR:")) throw error;
    return invalidCursor();
  }
}
