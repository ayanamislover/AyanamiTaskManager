import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

export type DaemonRuntime = {
  endpoint: string;
  token: string;
  pid: number;
  instanceId: string;
  version: string;
  startedAt: string;
};

function validRuntime(value: unknown): DaemonRuntime | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DaemonRuntime>;
  if (typeof candidate.endpoint !== "string" || typeof candidate.token !== "string") return null;
  try {
    const endpoint = new URL(candidate.endpoint);
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash ||
      candidate.token.length === 0 ||
      candidate.token.length > 512 ||
      !Number.isSafeInteger(candidate.pid) ||
      Number(candidate.pid) <= 0 ||
      typeof candidate.instanceId !== "string" ||
      !/^[a-f0-9]{32}$/u.test(candidate.instanceId) ||
      typeof candidate.version !== "string" ||
      !candidate.version ||
      typeof candidate.startedAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.startedAt))
    )
      return null;
  } catch {
    return null;
  }
  return candidate as DaemonRuntime;
}

export function defaultDataDir(): string {
  if (process.env.ATM_DATA_DIR) return process.env.ATM_DATA_DIR;
  const base = process.env.LOCALAPPDATA;
  if (!base) throw new Error("找不到 LOCALAPPDATA；请设置 ATM_DATA_DIR");
  return join(base, "AyanamiTaskManager");
}

async function readRuntime(dataDir = defaultDataDir()): Promise<DaemonRuntime | null> {
  try {
    return validRuntime(
      JSON.parse(await readFile(join(dataDir, "runtime", "daemon.json"), "utf8")) as unknown,
    );
  } catch {
    return null;
  }
}

async function runtimeAvailable(runtime: DaemonRuntime): Promise<boolean> {
  try {
    const response = await fetch(`${runtime.endpoint.replace(/\/$/u, "")}/api/v1/system/status`, {
      headers: { authorization: `Bearer ${runtime.token}` },
      signal: AbortSignal.timeout(750),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function discoverDaemon(
  input: {
    endpoint?: string;
    token?: string;
    waitMs?: number;
    dataDir?: string;
  } = {},
): Promise<DaemonRuntime> {
  const endpoint = input.endpoint ?? process.env.ATM_ENDPOINT;
  const token = input.token ?? process.env.ATM_TOKEN;
  if ((endpoint && !token) || (!endpoint && token))
    throw new Error("ATM_RUNTIME_OVERRIDE_INCOMPLETE");
  if (endpoint && token) {
    const explicit = validRuntime({
      endpoint,
      token,
      pid: process.pid,
      instanceId: "00000000000000000000000000000000",
      version: "explicit",
      startedAt: new Date().toISOString(),
    });
    if (!explicit) throw new Error("ATM_RUNTIME_ENDPOINT_INVALID");
    return explicit;
  }
  const dataDir = input.dataDir ?? defaultDataDir();
  const existing = await readRuntime(dataDir);
  if (existing && (await runtimeAvailable(existing))) return existing;

  if (/AyanamiTaskManager\.exe$/iu.test(process.execPath)) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, ["--background", "--agent-wake"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
    });
    child.unref();
    const deadline = Date.now() + (input.waitMs ?? 45_000);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const runtime = await readRuntime(dataDir);
      if (runtime && (await runtimeAvailable(runtime))) return runtime;
    }
  }
  throw new Error(
    "AyanamiTaskManager 服务未运行；请先启动桌面应用，测试隔离环境可设置 ATM_DATA_DIR",
  );
}
