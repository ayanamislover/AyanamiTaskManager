import { existsSync, writeFileSync } from "node:fs";

import { AyanamiTaskService } from "../../src/index.js";

const [dataDir, migrationsRoot, projectCode, workspaceRoot, operationId, readyPath, goPath] =
  process.argv.slice(2);

if (
  !dataDir ||
  !migrationsRoot ||
  !projectCode ||
  !workspaceRoot ||
  !operationId ||
  !readyPath ||
  !goPath
) {
  throw new Error("session begin worker arguments are incomplete");
}

const service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
try {
  writeFileSync(readyPath, String(process.pid), "utf8");
  const deadline = Date.now() + 15_000;
  while (!existsSync(goPath)) {
    if (Date.now() >= deadline) throw new Error("session begin worker barrier timed out");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  const result = await service.begin({
    operationId,
    projectCode,
    cwd: workspaceRoot,
    mode: "project",
    agentId: "codex-process-race",
    displayName: "Codex process race",
    clientKind: "test",
    role: "OBSERVER",
    threadId: "thr_process_race",
  });
  process.stdout.write(
    JSON.stringify({ session: result.session, disposition: result.atomicBegin?.disposition }),
  );
} finally {
  service.close();
}
