// 路由：按「原始路径逐段解码」匹配。键里的斜杠必须编码成 %2F，解码只发生在段内，
// 所以 `documents/a%2Fb` 的键是 `a/b`，而未编码的 `documents/a/b` 不匹配任何路由（404）。
import { badRequest } from "./errors.js";

export type Route =
  | { kind: "health" }
  | { kind: "app"; app: string }
  | { kind: "documents"; app: string }
  | { kind: "document"; app: string; key: string }
  | { kind: "changes"; app: string };

export const ROUTE_METHODS: Readonly<Record<Route["kind"], readonly string[]>> = Object.freeze({
  health: ["GET", "HEAD"],
  app: ["GET"],
  documents: ["GET"],
  document: ["GET", "PUT", "DELETE"],
  changes: ["GET"],
});

export type ParsedUrl = { path: string; query: URLSearchParams };

/** 拆出路径与查询串。代理可能发来绝对形式的请求目标（http://host/path），一并处理。 */
export function splitUrl(raw: string): ParsedUrl {
  let target = raw;
  if (!target.startsWith("/")) {
    try {
      const parsed = new URL(target);
      target = `${parsed.pathname}${parsed.search}`;
    } catch {
      throw badRequest("请求路径不合法");
    }
  }
  const mark = target.indexOf("?");
  const path = mark === -1 ? target : target.slice(0, mark);
  const query = new URLSearchParams(mark === -1 ? "" : target.slice(mark + 1));
  return { path, query };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw badRequest("路径里的百分号编码不合法");
  }
}

/** 匹配不上返回 null（调用方回 404）；段内编码坏掉抛 400。 */
export function matchRoute(path: string): Route | null {
  const raw = path.split("/");
  if (raw[0] !== "" || raw.length < 2) return null;
  if (raw.some((segment, index) => index > 0 && segment === "")) return null;
  const segments = raw.slice(1).map(decodeSegment);
  const [first, second, app, section, key, ...rest] = segments;
  if (first === "health" && second === "live" && segments.length === 2) return { kind: "health" };
  if (first !== "v1" || second !== "apps" || app === undefined || rest.length > 0) return null;
  if (section === undefined) return { kind: "app", app };
  if (section === "documents") {
    return key === undefined ? { kind: "documents", app } : { kind: "document", app, key };
  }
  if (section === "changes" && key === undefined) return { kind: "changes", app };
  return null;
}
