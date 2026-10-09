// 录 2.0 TS daemon 的界面 API 形状（06 T-COMPAT）：在进程内起 2.0 daemon，跑 ui-scenario.json，
// 把每一步应答的状态码与形状骨架写进 ui-shapes-2.0.json，tests/compat.rs 拿它比 Rust 的 ui-bridge。
//
// 在仓库根目录跑：node node_modules/tsx/dist/cli.mjs apps/desktop/native/ui-bridge/tests/fixtures/capture-2.0.ts
// 数据目录在 output/w5-evidence/ui-capture，开始与结束都整个删掉。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AyanamiTaskService } from "../../../../../../packages/application/src/index.js";
import { buildAyanamiServer } from "../../../../../../apps/daemon/src/index.js";

const here = resolve("apps/desktop/native/ui-bridge/tests/fixtures");
const scenario = JSON.parse(readFileSync(join(here, "ui-scenario.json"), "utf8")) as {
  steps: Array<Record<string, any>>;
};
const dataDir = resolve("output/w5-evidence/ui-capture");
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

type Skeleton = string | { [key: string]: Skeleton } | { "[]": Skeleton };

function skeleton(value: unknown): Skeleton {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return { "[]": value.map(skeleton).reduce(merge) };
  }
  if (typeof value === "object") {
    const out: Record<string, Skeleton> = {};
    for (const key of Object.keys(value as object).sort())
      out[key] = skeleton((value as Record<string, unknown>)[key]);
    return out;
  }
  return typeof value;
}

/** 数组元素的骨架合并：键取并集，null 让位给具体类型，类型不同记成 `a|b`。与 compat.rs 的 merge 一致。 */
function merge(a: Skeleton, b: Skeleton): Skeleton {
  if (a === "null") return b;
  if (b === "null") return a;
  if (typeof a === "string" || typeof b === "string") {
    if (a === "[]" && typeof b === "object" && "[]" in b) return b;
    if (b === "[]" && typeof a === "object" && "[]" in a) return a;
    if (JSON.stringify(a) === JSON.stringify(b)) return a;
    const names = new Set([...describe(a).split("|"), ...describe(b).split("|")]);
    return [...names].sort().join("|");
  }
  const out: Record<string, Skeleton> = {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const left = (a as Record<string, Skeleton>)[key];
    const right = (b as Record<string, Skeleton>)[key];
    out[key] = left === undefined ? right! : right === undefined ? left : merge(left, right);
  }
  return out;
}

function describe(s: Skeleton): string {
  if (typeof s === "string") return s;
  return "[]" in s ? "array" : "object";
}

/** JSON Pointer，外加 `k=v` 段：在数组里挑 `k` 等于 `v` 的那一项。 */
function pointer(value: unknown, path: string): unknown {
  let at: any = value;
  for (const raw of path.split("/").slice(1)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(at) && segment.includes("=")) {
      const [k, v] = segment.split("=");
      at = at.find((item) => String(item?.[k!]) === v);
    } else at = at?.[segment];
  }
  return at;
}

function fill(value: unknown, saved: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{(\w+)\}\}$/u.exec(value);
    if (whole) return need(saved, whole[1]!);
    return value.replace(/\{\{(\w+)\}\}/gu, (_, name: string) => String(need(saved, name)));
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, saved));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, saved)]));
  return value;
}

function need(saved: Record<string, unknown>, name: string): unknown {
  if (!(name in saved)) throw new Error(`场景引用了还没存下的 ${name}`);
  return saved[name];
}

const TOKEN = "capture-token";
const service = await AyanamiTaskService.open({ dataDir, migrationsRoot: resolve("migrations") });
const app = await buildAyanamiServer({
  service,
  token: TOKEN,
  startedAt: "2000-01-01T00:00:00.000Z",
});
const saved: Record<string, unknown> = {};
const shapes: Record<string, { status: number; code?: string; shape: Skeleton }> = {};
let rpc = 1;
const mismatches: string[] = [];
try {
  for (const step of scenario.steps) {
    let body: unknown;
    let status: number;
    if (step.agent) {
      const response = await app.inject({
        method: "POST",
        url: "/mcp/core",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        payload: {
          jsonrpc: "2.0",
          id: rpc++,
          method: "tools/call",
          params: { name: step.agent, arguments: fill(step.args, saved) },
        },
      });
      const text = response.headers["content-type"]?.includes("text/event-stream")
        ? response.body
            .split(/\r?\n/u)
            .find((line) => line.startsWith("data:"))!
            .slice(5)
        : response.body;
      const parsed = JSON.parse(text);
      if (parsed.error || parsed.result?.isError) throw new Error(`${step.name}: ${text}`);
      body = parsed.result.structuredContent;
      status = 200;
    } else {
      const payload = step.body === undefined ? undefined : fill(step.body, saved);
      const response = await app.inject({
        method: step.method,
        url: fill(step.path, saved) as string,
        headers: { authorization: `Bearer ${TOKEN}` },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      status = response.statusCode;
      body = response.body ? response.json() : null;
      if (status !== step.status)
        mismatches.push(
          `${step.name}: 期望 ${step.status}，实际 ${status} ${response.body.slice(0, 400)}`,
        );
      const code = (body as { error?: { code?: string } } | null)?.error?.code;
      shapes[step.name] = { status, ...(code ? { code } : {}), shape: skeleton(body) };
    }
    for (const [name, path] of Object.entries((step.save ?? {}) as Record<string, string>)) {
      const value = pointer(body, path);
      if (value === undefined)
        throw new Error(`${step.name}: ${path} 不存在于 ${JSON.stringify(body)}`);
      saved[name] = value;
    }
    if (process.env.CAPTURE_VERBOSE)
      console.log(step.name, status, JSON.stringify(body).slice(0, 600));
  }
} finally {
  await app.close();
  service.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
}
if (mismatches.length > 0) {
  console.error(mismatches.join("\n"));
  process.exit(1);
}
writeFileSync(join(here, "ui-shapes-2.0.json"), `${JSON.stringify(shapes, null, 2)}\n`);
console.log(`captured ${Object.keys(shapes).length} shapes`);
