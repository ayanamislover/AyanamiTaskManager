import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// 3.0 的 e2e（W5d）：服务是 Rust 的 atm-core-e2e（与正式宿主同一个运行时库），界面在 Vite 里。
// - 界面经 4394 进 ui-bridge（主体 User/E2eTest），只认用户 token；
// - 用例里的 Agent 照真实 Agent 的做法从 N\runtime\daemon.json 读端点与令牌（e2e/agent.ts）。
const workspace = resolve(process.cwd());
const output = resolve(workspace, "output", "e2e");
const dataDir = resolve(output, "data");
if (!dataDir.toLowerCase().startsWith(`${workspace.toLowerCase()}${sep}`)) {
  throw new Error(`E2E_DATA_OUTSIDE_WORKSPACE: ${dataDir}`);
}
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const native = join(workspace, "apps", "desktop", "native");
const target = join(native, "target");
const build = spawnSync(
  "cargo",
  ["build", "--locked", "-p", "atm-e2e-adapter", "--features", "e2e", "--bin", "atm-core-e2e"],
  {
    cwd: native,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, CARGO_TARGET_DIR: target },
  },
);
if (build.status !== 0) throw new Error(`E2E_ADAPTER_BUILD_FAILED: ${build.status}`);

// 数据根只在 output/e2e 下；不从环境继承任何 ATM 数据根变量。
const env = { ...process.env };
for (const name of ["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM3_DATA_DIR"]) delete env[name];

const node = process.execPath;
const children: ChildProcess[] = [];
const core = spawn(
  join(target, "debug", "atm-core-e2e.exe"),
  [
    "--n",
    join(dataDir, "v3"),
    "--legacy",
    join(dataDir, "legacy"),
    "--port",
    "4394",
    "--origin",
    "http://127.0.0.1:9999",
    "--user-token",
    "e2e-user-token",
  ],
  { cwd: workspace, stdio: "inherit", windowsHide: true, env },
);
children.push(core);
const vite = spawn(
  node,
  [
    "node_modules/vite/bin/vite.js",
    "--config",
    "apps/desktop/vite.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    "9999",
    "--strictPort",
  ],
  {
    cwd: workspace,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...env,
      VITE_ATM_ENDPOINT: "http://127.0.0.1:4394",
      VITE_ATM_TOKEN: "e2e-user-token",
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
