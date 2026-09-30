// 六个数据接口的处理。认证、限流、方法校验已在 server.ts 做完，这里只管业务。
import type { IncomingMessage, ServerResponse } from "node:http";
import { appDetail } from "./app-detail.js";
import type { Database } from "./database.js";
import {
  type ChangePage,
  checkDataSize,
  deleteDocument,
  documentJson,
  getDocument,
  listChanges,
  listDocuments,
  putDocument,
  validateKey,
} from "./documents.js";
import { invalidArgument, notFound, tooManyRequests } from "./errors.js";
import { readBody, sendJson, sendJsonText, sendNoContent } from "./http-io.js";
import type { RelayLimits } from "./limits.js";
import type { ChangeNotifier } from "./notifier.js";
import type { WaiterGate } from "./rate-limit.js";
import { compactJson, parsePutBody } from "./request-body.js";
import type { Route } from "./routes.js";
import { type AppRow, type Principal, getApp } from "./tokens.js";

export type RelayContext = {
  db: Database;
  limits: RelayLimits;
  notifier: ChangeNotifier;
  waiters: WaiterGate;
  isClosing: () => boolean;
  now: () => number;
};

export type RequestParts = {
  req: IncomingMessage;
  res: ServerResponse;
  query: URLSearchParams;
  principal: Principal;
};

/** 与 AyanamiCloud 的 QueryLimit 相同：缺省或非法取 100，上限 500。 */
function parseLimit(raw: string | null): number {
  if (raw === null || raw === "" || !/^[+-]?\d+$/.test(raw)) return 100;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return 100;
  return Math.min(value, 500);
}

function parseWait(raw: string | null, max: number): number {
  if (raw === null || raw === "") return 0;
  if (!/^\d{1,6}$/.test(raw)) throw invalidArgument(`wait 必须是 0–${max} 的整数（秒）`);
  return Math.min(Number(raw), max);
}

function requireApp(db: Database, appId: string): AppRow {
  const app = getApp(db, appId);
  if (!app) throw notFound("应用不存在");
  return app;
}

const DEVICE_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

async function putDocumentRoute(
  ctx: RelayContext,
  appId: string,
  key: string,
  parts: RequestParts,
): Promise<void> {
  const body = parsePutBody(await readBody(parts.req, ctx.limits.maxBodyBytes));
  validateKey(key);
  if (body.expectedRevision === null) throw invalidArgument("缺少 expected_revision");
  if (body.expectedRevision < 0) throw invalidArgument("expected_revision 不能为负");
  if (body.dataRaw === null) throw invalidArgument("缺少 data");
  const sizeBytes = Buffer.byteLength(body.dataRaw, "utf8");
  checkDataSize(sizeBytes, ctx.limits);
  if (body.deviceId !== null && !DEVICE_ID_PATTERN.test(body.deviceId)) {
    throw invalidArgument("device_id 只能是 1–128 个可见 ASCII 字符");
  }
  requireApp(ctx.db, appId);
  const result = putDocument(
    ctx.db,
    {
      appId,
      key,
      expectedRevision: body.expectedRevision,
      data: compactJson(body.dataRaw),
      sizeBytes,
      schemaVersion:
        body.schemaVersion === null || body.schemaVersion <= 0 ? 1 : body.schemaVersion,
      deviceId: body.deviceId,
    },
    ctx.limits,
    ctx.now(),
  );
  ctx.notifier.notify(appId);
  sendJsonText(parts.res, result.created ? 201 : 200, documentJson(result.document));
}

function deleteDocumentRoute(
  ctx: RelayContext,
  appId: string,
  key: string,
  parts: RequestParts,
): void {
  const raw = parts.query.get("expected_revision");
  if (raw === null || raw === "") throw invalidArgument("缺少 expected_revision");
  if (!/^\+?\d{1,15}$/.test(raw)) throw invalidArgument("expected_revision 不合法");
  validateKey(key);
  requireApp(ctx.db, appId);
  deleteDocument(ctx.db, appId, key, Number(raw), ctx.limits, ctx.now());
  ctx.notifier.notify(appId);
  sendNoContent(parts.res);
}

/**
 * 长轮询：先查一次，有变更或 wait=0 立即返回；否则挂起到本 app 有写入、超时、客户端断开或进程关闭。
 * 查询与订阅在同一个同步片段里完成（node:sqlite 是同步的），中间插不进别的写入，不会漏唤醒。
 */
async function changesRoute(ctx: RelayContext, appId: string, parts: RequestParts): Promise<void> {
  requireApp(ctx.db, appId);
  const cursor = parts.query.get("cursor") ?? "";
  const limit = parseLimit(parts.query.get("limit"));
  const wait = parseWait(parts.query.get("wait"), ctx.limits.maxWaitSeconds);
  const first: ChangePage = listChanges(ctx.db, appId, cursor, limit);
  if (first.changes.length > 0 || wait === 0 || ctx.isClosing()) {
    sendJson(parts.res, 200, first);
    return;
  }
  const tokenId = parts.principal.tokenId;
  if (!ctx.waiters.acquire(tokenId)) {
    throw tooManyRequests("TOO_MANY_WAITERS", "同时挂起的长轮询过多，请稍后再试", 1);
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      parts.res.off("close", finish);
      ctx.waiters.release(tokenId);
      resolve();
    };
    const unsubscribe = ctx.notifier.subscribe(appId, finish);
    const timer = setTimeout(finish, wait * 1000);
    parts.res.on("close", finish);
  });
  if (parts.res.destroyed || parts.res.writableEnded) return;
  if (ctx.isClosing()) parts.res.setHeader("Connection", "close");
  sendJson(parts.res, 200, listChanges(ctx.db, appId, cursor, limit));
}

export async function handleRoute(
  ctx: RelayContext,
  route: Exclude<Route, { kind: "health" }>,
  parts: RequestParts,
): Promise<void> {
  const method = parts.req.method ?? "GET";
  switch (route.kind) {
    case "app": {
      const app = requireApp(ctx.db, route.app);
      sendJson(parts.res, 200, appDetail(ctx.db, app, ctx.limits, ctx.now()));
      return;
    }
    case "documents": {
      requireApp(ctx.db, route.app);
      const page = listDocuments(
        ctx.db,
        route.app,
        parts.query.get("prefix") ?? "",
        parts.query.get("cursor") ?? "",
        parseLimit(parts.query.get("limit")),
      );
      sendJson(parts.res, 200, page);
      return;
    }
    case "changes":
      await changesRoute(ctx, route.app, parts);
      return;
    case "document": {
      if (method === "PUT") {
        await putDocumentRoute(ctx, route.app, route.key, parts);
        return;
      }
      if (method === "DELETE") {
        deleteDocumentRoute(ctx, route.app, route.key, parts);
        return;
      }
      validateKey(route.key);
      requireApp(ctx.db, route.app);
      const document = getDocument(ctx.db, route.app, route.key);
      if (!document) throw notFound("文档不存在");
      sendJsonText(parts.res, 200, documentJson(document));
      return;
    }
  }
}
