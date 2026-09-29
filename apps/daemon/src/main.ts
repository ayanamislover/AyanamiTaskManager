import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import {
  buildAyanamiServer,
  acquireDaemonRuntime,
  createDaemonToken,
  DAEMON_VERSION,
  resolveDaemonDataDirectory,
} from "./index.js";

function dataDirectory(): string {
  return resolveDaemonDataDirectory();
}

/**
 * 独立 daemon 只用于开发与 e2e（ATM-T-0503）。显式给了 AYANAMI_TASK_USER_TOKEN 才分离凭证，
 * 否则保持单 token：那一个 token 同时代表用户，用户操作路由不设防——安装版桌面不走这里。
 */
function standaloneUserToken(agentToken: string): string | undefined {
  const value = process.env.AYANAMI_TASK_USER_TOKEN;
  if (value === undefined || value === "") return undefined;
  if (value === agentToken)
    throw new Error("AYANAMI_TASK_USER_TOKEN 不能与 Agent token 相同，否则分离凭证形同虚设");
  return value;
}

async function main(): Promise<void> {
  const dataDir = dataDirectory();
  const runtime = join(dataDir, "runtime");
  mkdirSync(runtime, { recursive: true });
  const lease = acquireDaemonRuntime(runtime);
  const token = createDaemonToken();
  const userToken = standaloneUserToken(token);
  let service: AyanamiTaskService | null = null;
  let app: Awaited<ReturnType<typeof buildAyanamiServer>> | null = null;
  try {
    const migrationsRoot = resolve(process.env.AYANAMI_TASK_MIGRATIONS_DIR ?? "migrations");
    service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    const startedAt = new Date().toISOString();
    app = await buildAyanamiServer({
      service,
      token,
      startedAt,
      ...(userToken === undefined ? {} : { userToken }),
    });
    const address = await app.listen({
      host: "127.0.0.1",
      port: Number(process.env.AYANAMI_TASK_PORT ?? 4393),
    });
    lease.publish({
      endpoint: address,
      token,
      pid: process.pid,
      instanceId: lease.instanceId,
      version: DAEMON_VERSION,
      startedAt,
    });
  } catch (error) {
    if (app) await app.close().catch(() => undefined);
    service?.close();
    lease.release();
    throw error;
  }
  const initialMaintenance = setTimeout(() => {
    void service.runMaintenance();
  }, 2500);
  const maintenance = setInterval(
    () => {
      void service.runMaintenance();
    },
    60 * 60 * 1000,
  );
  maintenance.unref();
  const close = async () => {
    clearTimeout(initialMaintenance);
    clearInterval(maintenance);
    await app.close();
    service.close();
    lease.clear();
    lease.release();
  };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
