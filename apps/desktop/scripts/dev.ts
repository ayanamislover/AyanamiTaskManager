import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 源码运行：debug 宿主 + 源码 core（tsx），renderer 由 vite 持续构建到 dist/renderer。
 *
 * debug 宿主只在设了 ATM_DEV_REPOSITORY_ROOT 时才认源码布局（native/host/src/paths.rs）。
 * 数据目录默认放在 output/dev-data，和本机正在用的 ATM 分开——同一个数据根只能有一个主实例。
 */
const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const native = resolve(root, "apps/desktop/native");
const dataDir = process.env.ATM_DATA_DIR ?? resolve(root, "output/dev-data");
mkdirSync(dataDir, { recursive: true });

execFileSync("cargo", ["build", "--locked", "-p", "atm-host"], { cwd: native, stdio: "inherit" });
const viteConfig = ["--config", "apps/desktop/vite.config.ts"];
const vite = resolve(root, "node_modules/vite/bin/vite.js");
execFileSync(process.execPath, [vite, "build", ...viteConfig], { cwd: root, stdio: "inherit" });
const watcher = spawn(process.execPath, [vite, "build", "--watch", ...viteConfig], {
  cwd: root,
  stdio: "inherit",
});
const host = spawn(resolve(native, "target/debug/AyanamiTaskManager.exe"), [], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ATM_DEV_REPOSITORY_ROOT: root, ATM_DATA_DIR: dataDir },
});
host.on("exit", (code) => {
  watcher.kill();
  process.exitCode = code ?? 0;
});
