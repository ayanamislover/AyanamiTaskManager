import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
execFileSync(
  process.execPath,
  [
    resolve(root, "node_modules/tsup/dist/cli-default.js"),
    "--config",
    "apps/desktop/tsup.config.ts",
  ],
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
