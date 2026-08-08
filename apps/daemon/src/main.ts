import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "./index.js";

function dataDirectory(): string {
  if (process.env.AYANAMI_TASK_DATA_DIR) return resolve(process.env.AYANAMI_TASK_DATA_DIR);
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error("LOCALAPPDATA is required");
  return join(local, "AyanamiTaskManager");
}

async function main(): Promise<void> {
  const dataDir = dataDirectory();
  const runtime = join(dataDir, "runtime");
  mkdirSync(runtime, { recursive: true });
  const tokenPath = join(runtime, "local.token");
  if (!existsSync(tokenPath)) {
    writeFileSync(
      tokenPath,
      process.env.AYANAMI_TASK_TOKEN ?? randomBytes(32).toString("base64url"),
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    );
  }
  const token = readFileSync(tokenPath, "utf8").trim();
  const migrationsRoot = resolve(process.env.AYANAMI_TASK_MIGRATIONS_DIR ?? "migrations");
  const service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
  const app = await buildAyanamiServer({ service, token });
  const address = await app.listen({
    host: "127.0.0.1",
    port: Number(process.env.AYANAMI_TASK_PORT ?? 4393),
  });
  writeFileSync(
    join(runtime, "daemon.json"),
    `${JSON.stringify({ endpoint: address, token, pid: process.pid, version: "1.0.0", startedAt: new Date().toISOString() })}\n`,
    "utf8",
  );
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
  };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
