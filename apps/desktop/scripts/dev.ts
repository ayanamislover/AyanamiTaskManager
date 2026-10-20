import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 源码运行：debug 宿主（服务在宿主进程里），renderer 由 vite 持续构建到 dist/renderer。
 *
 * debug 宿主只在设了 ATM_DEV_REPOSITORY_ROOT 时才认源码布局（native/host/src/paths.rs）。
 * 两个数据根都默认放在 output/ 下，和本机正在用的 ATM 分开——同一个数据根只能有一个主实例：
 * 2.x 源根 `ATM_DATA_DIR`（output/dev-data），3.0 数据根 `ATM3_DATA_DIR`（output/dev-data3）。
 * 只设 2.x 源根不够：宿主的 3.0 数据根另由 ATM3_DATA_DIR 决定，没设就是真实的
 * `%LOCALAPPDATA%\AyanamiTaskManager3`。
 */
export function devEnvironment(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pick = (name: string, fallback: string) => {
    const value = env[name];
    return value ? value : resolve(root, fallback);
  };
  return {
    ...env,
    ATM_DEV_REPOSITORY_ROOT: root,
    ATM_DATA_DIR: pick("ATM_DATA_DIR", "output/dev-data"),
    ATM3_DATA_DIR: pick("ATM3_DATA_DIR", "output/dev-data3"),
  };
}

function main(): void {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  const native = resolve(root, "apps/desktop/native");
  const env = devEnvironment(root, process.env);
  mkdirSync(env.ATM_DATA_DIR as string, { recursive: true });
  mkdirSync(env.ATM3_DATA_DIR as string, { recursive: true });

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
    env,
  });
  host.on("exit", (code) => {
    watcher.kill();
    process.exitCode = code ?? 0;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
