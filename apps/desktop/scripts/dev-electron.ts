import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    const response = await fetch("http://127.0.0.1:5174");
    if (response.ok) break;
  } catch {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}
execFileSync(
  process.execPath,
  [resolve(root, "node_modules/tsx/dist/cli.mjs"), "apps/desktop/scripts/build.ts"],
  { cwd: root, stdio: "inherit" },
);
const child = spawn(process.execPath, [resolve(root, "node_modules/electron/cli.js"), "."], {
  cwd: root,
  stdio: "inherit",
  windowsHide: false,
  env: { ...process.env, ATM_RENDERER_URL: "http://127.0.0.1:5174" },
});
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
