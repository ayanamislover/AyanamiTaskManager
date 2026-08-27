import { existsSync, writeFileSync } from "node:fs";
import { AyanamiTaskService } from "../../src/index.js";

const [dataDir, migrationsRoot, projectCode, oldSession, operationId, readyPath, goPath] =
  process.argv.slice(2);

if (
  !dataDir ||
  !migrationsRoot ||
  !projectCode ||
  !oldSession ||
  !operationId ||
  !readyPath ||
  !goPath
) {
  throw new Error("startup successor worker arguments are incomplete");
}

const service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
try {
  writeFileSync(readyPath, String(process.pid), "utf8");
  const deadline = Date.now() + 15_000;
  while (!existsSync(goPath)) {
    if (Date.now() >= deadline) throw new Error("startup successor worker barrier timed out");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  const result = await service.createRecord(projectCode, oldSession, operationId, {
    kind: "FACT",
    title: "并发恢复",
    summary: "相同 op 只写一次",
  });
  process.stdout.write(
    JSON.stringify({
      key: result.key,
      newSession: result.newSession,
      sessionRebound: result.sessionRebound,
    }),
  );
} finally {
  service.close();
}
