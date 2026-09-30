// 测试夹具：在 mkdtemp 目录里起一个真实的 atm-relay（随机端口），用完关掉并删目录。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INITIAL_TOKEN_FILE } from "../../src/bootstrap.js";
import type { RelayLimits } from "../../src/limits.js";
import type { RelayLogger } from "../../src/log.js";
import { type RunningRelay, startRelay } from "../../src/server.js";

export const TEMP_PREFIX = "atm-relay-test-";

const directories: string[] = [];

export function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  directories.push(dir);
  return dir;
}

/** afterEach 里调用：删掉本文件建过的全部临时目录。 */
export function removeTempDirs(): void {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export type TestRelay = {
  relay: RunningRelay;
  dataDir: string;
  baseUrl: string;
  token: string;
  stop(): Promise<void>;
};

export type TestRelayOptions = {
  dataDir?: string;
  limits?: Partial<RelayLimits>;
  log?: RelayLogger;
  accessLog?: boolean;
  now?: () => number;
  trustProxy?: boolean;
};

const running = new Set<RunningRelay>();

export async function startTestRelay(options: TestRelayOptions = {}): Promise<TestRelay> {
  const dataDir = options.dataDir ?? tempDataDir();
  const relay = await startRelay({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    limits: { requestsPerSecond: 10_000, ...(options.limits ?? {}) },
    ...(options.log ? { log: options.log } : {}),
    ...(options.accessLog ? { accessLog: true } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.trustProxy ? { trustProxy: true } : {}),
  });
  running.add(relay);
  const token = readFileSync(join(dataDir, INITIAL_TOKEN_FILE), "utf8").trim();
  return {
    relay,
    dataDir,
    baseUrl: relay.url,
    token,
    async stop() {
      running.delete(relay);
      await relay.close();
    },
  };
}

/** afterEach 里调用：关掉还开着的中继（先于删目录，否则 Windows 上库文件删不掉）。 */
export async function stopAllRelays(): Promise<void> {
  for (const relay of [...running]) {
    running.delete(relay);
    await relay.close();
  }
}

export async function cleanupHarness(): Promise<void> {
  await stopAllRelays();
  removeTempDirs();
}

/** 收集日志文本，用来断言「日志里没有 token 与 data」。 */
export function capturingLogger(): { log: RelayLogger; text: () => string } {
  const lines: string[] = [];
  const push = (level: string) => (message: string) => lines.push(`${level} ${message}`);
  return {
    log: { info: push("INFO"), warn: push("WARN"), error: push("ERROR") },
    text: () => lines.join("\n"),
  };
}

export type Json = any;

export async function call(
  base: TestRelay | string,
  method: string,
  path: string,
  init: {
    token?: string | null;
    body?: unknown;
    rawBody?: string | Buffer;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<{ status: number; json: Json; text: string; headers: Headers; elapsedMs: number }> {
  const baseUrl = typeof base === "string" ? base : base.baseUrl;
  const token = init.token === undefined && typeof base !== "string" ? base.token : init.token;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: string | Buffer | undefined;
  if (init.rawBody !== undefined) body = init.rawBody;
  else if (init.body !== undefined) body = JSON.stringify(init.body);
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const text = await response.text();
  let json: Json = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    json,
    text,
    headers: response.headers,
    elapsedMs: performance.now() - started,
  };
}
