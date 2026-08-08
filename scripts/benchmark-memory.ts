import { join, resolve } from "node:path";
import { AyanamiTaskService } from "../packages/application/src/index.js";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("BENCHMARK_DATA_DIR_REQUIRED");
const service = await AyanamiTaskService.open({
  dataDir: resolve(dataDir),
  migrationsRoot: join(process.cwd(), "migrations"),
});
service.overview();
await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
process.stdout.write(`${JSON.stringify({ rssMb: process.memoryUsage().rss / 1024 / 1024 })}\n`);
service.close();
