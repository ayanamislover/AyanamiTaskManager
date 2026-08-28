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

async function main(): Promise<void> {
  const dataDir = dataDirectory();
  const runtime = join(dataDir, "runtime");
  mkdirSync(runtime, { recursive: true });
  const lease = acquireDaemonRuntime(runtime);
  const token = createDaemonToken();
  let service: AyanamiTaskService | null = null;
  let app: Awaited<ReturnType<typeof buildAyanamiServer>> | null = null;
  try {
    const migrationsRoot = resolve(process.env.AYANAMI_TASK_MIGRATIONS_DIR ?? "migrations");
    service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    app = await buildAyanamiServer({ service, token });
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
      startedAt: new Date().toISOString(),
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
