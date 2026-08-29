import { join, resolve } from "node:path";
import { AyanamiTaskService } from "../packages/application/src/index.js";
import { stableIdleRssMegabytes } from "./benchmark-memory-policy.js";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("BENCHMARK_DATA_DIR_REQUIRED");
const service = await AyanamiTaskService.open({
  dataDir: resolve(dataDir),
  migrationsRoot: join(process.cwd(), "migrations"),
});
service.overview();
const rssSamplesMb: number[] = [];
for (let index = 0; index < 5; index += 1) {
  // Idle RSS should measure the retained service footprint, not whichever
  // young-generation pages happen to remain committed after module startup.
  // The probe is launched with --expose-gc and discards two warm-up samples.
  globalThis.gc?.();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  rssSamplesMb.push(process.memoryUsage().rss / 1024 / 1024);
}
const rssMb = stableIdleRssMegabytes(rssSamplesMb);
process.stdout.write(`${JSON.stringify({ rssMb, rssSamplesMb })}\n`);
service.close();
