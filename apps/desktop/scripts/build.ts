import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 桌面端的 JS 产物：core / CLI 单文件（build-core.ts）与 renderer。原生宿主由 cargo 构建。 */
const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
execFileSync(
  process.execPath,
  [resolve(root, "node_modules/tsx/dist/cli.mjs"), "apps/desktop/scripts/build-core.ts"],
  { cwd: root, stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [
    resolve(root, "node_modules/vite/bin/vite.js"),
    "build",
    "--config",
    "apps/desktop/vite.config.ts",
  ],
  {
    cwd: root,
    stdio: "inherit",
  },
);
