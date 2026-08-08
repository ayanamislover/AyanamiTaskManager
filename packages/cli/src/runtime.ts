import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

export type DaemonRuntime = { endpoint: string; token: string; pid?: number };

export function defaultDataDir(): string {
  if (process.env.ATM_DATA_DIR) return process.env.ATM_DATA_DIR;
  const base = process.env.LOCALAPPDATA;
  if (!base) throw new Error("找不到 LOCALAPPDATA；请设置 ATM_DATA_DIR");
  return join(base, "AyanamiTaskManager");
}

async function readRuntime(): Promise<DaemonRuntime | null> {
  try {
    return JSON.parse(
      await readFile(join(defaultDataDir(), "runtime", "daemon.json"), "utf8"),
    ) as DaemonRuntime;
  } catch {
    return null;
  }
}

export async function discoverDaemon(
  input: {
    endpoint?: string;
    token?: string;
    waitMs?: number;
  } = {},
): Promise<DaemonRuntime> {
  if (input.endpoint && input.token) return { endpoint: input.endpoint, token: input.token };
  const existing = await readRuntime();
  if (existing) return existing;

  if (/AyanamiTaskManager\.exe$/iu.test(process.execPath)) {
    const child = spawn(process.execPath, ["--background"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    const deadline = Date.now() + (input.waitMs ?? 8000);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const runtime = await readRuntime();
      if (runtime) return runtime;
    }
  }
  throw new Error("AyanamiTaskManager 服务未运行；请先启动桌面应用或设置 --endpoint 与 --token");
}
