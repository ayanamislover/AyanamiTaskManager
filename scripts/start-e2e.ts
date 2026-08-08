import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";

const workspace = resolve(process.cwd());
const output = resolve(workspace, "output", "e2e");
const dataDir = resolve(output, "data");
if (!dataDir.toLowerCase().startsWith(`${workspace.toLowerCase()}${sep}`)) {
  throw new Error(`E2E_DATA_OUTSIDE_WORKSPACE: ${dataDir}`);
}
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const node = process.execPath;
const children: ChildProcess[] = [];
const daemon = spawn(node, ["node_modules/tsx/dist/cli.mjs", "apps/daemon/src/main.ts"], {
  cwd: workspace,
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    AYANAMI_TASK_DATA_DIR: dataDir,
    AYANAMI_TASK_TOKEN: "e2e-test-token",
    AYANAMI_TASK_PORT: "4394",
  },
});
children.push(daemon);
const vite = spawn(
  node,
  [
    "node_modules/vite/bin/vite.js",
    "--config",
    "apps/desktop/vite.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    "5175",
  ],
  {
    cwd: workspace,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      VITE_ATM_ENDPOINT: "http://127.0.0.1:4394",
      VITE_ATM_TOKEN: "e2e-test-token",
    },
  },
);
children.push(vite);

let stopping = false;
function stop(exitCode = 0): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill();
  process.exitCode = exitCode;
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}

await new Promise<void>((resolvePromise) => {
  process.on("beforeExit", () => resolvePromise());
});
