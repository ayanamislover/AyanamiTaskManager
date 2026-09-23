// Launched inside a test-only kill-on-close Job by independent-wake-smoke.ps1.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const mode = process.env.ATM_WAKE_PROBE_MODE ?? "stdio";
const root = path.resolve("output", "independent-wake-" + mode + "-" + process.pid);
const data = path.join(root, "data");
fs.mkdirSync(data, { recursive: true });
const exe = path.resolve(
  process.env.ATM_PACKAGED_EXE ?? "out/AyanamiTaskManager-win32-x64/AyanamiTaskManager.exe",
);
const bridge = path.join(path.dirname(exe), "resources", "mcp-stdio.cjs");
fs.copyFileSync(bridge, path.join(data, "mcp-stdio.cjs"));
// Exercise forced-termination recovery too: stale descriptor, no live daemon.
fs.mkdirSync(path.join(data, "runtime"), { recursive: true });
fs.writeFileSync(
  path.join(data, "runtime", "daemon.json"),
  JSON.stringify({
    endpoint: "http://127.0.0.1:1",
    token: "isolated-stale-token",
    pid: 2147483647,
    instanceId: "0".repeat(32),
    version: "stale",
    startedAt: new Date().toISOString(),
  }),
);
const env = {
  ...process.env,
  ATM_DATA_DIR: data,
  ATM_PACKAGED_SMOKE: "1",
  ATM_SMOKE_AGENT_CONFIG_ROOT: path.join(root, "agent"),
  ATM_WAKE_USER_DATA_DIR: path.join(root, "electron"),
  HOME: path.join(root, "Home"),
  USERPROFILE: path.join(root, "Home"),
  APPDATA: path.join(root, "Roaming"),
  LOCALAPPDATA: path.join(root, "Local"),
};
delete env.ELECTRON_RUN_AS_NODE;
let launched = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (command) => {
  if (command.trim() === "exit") {
    process.exit(0);
    return;
  }
  if (launched) return;
  launched = true;
  try {
    const child =
      mode === "stdio"
        ? spawn(exe, [bridge, "--profile", "core"], {
            env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          })
        : mode === "legacy"
          ? spawn(
              exe,
              ["--background", "--agent-wake", "--user-data-dir=" + path.join(root, "electron")],
              { env, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
            )
          : spawn(exe, ["--user-data-dir=" + path.join(root, "cli-profile"), "--cli", "status"], {
              env,
              windowsHide: true,
              stdio: ["pipe", "pipe", "pipe"],
            });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (b) => (output += b.toString()));
    child.stderr.on("data", (b) => (errorOutput = (errorOutput + b.toString()).slice(-2000)));
    if (mode === "stdio")
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "isolated-job-test", version: "1" },
          },
        }) + "\n",
      );
    let runtime;
    for (let i = 0; i < 250; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        runtime = JSON.parse(fs.readFileSync(path.join(data, "runtime", "daemon.json"), "utf8"));
        if (runtime.version === "stale") continue;
        const res = await fetch(runtime.endpoint + "/api/v1/system/status", {
          headers: { authorization: "Bearer " + runtime.token },
          signal: AbortSignal.timeout(500),
        });
        if (
          res.ok &&
          (mode === "legacy" || output.includes(mode === "stdio" ? "serverInfo" : "version"))
        )
          break;
      } catch {
        /* Runtime descriptor and listener are published asynchronously. */
      }
    }
    if (
      !runtime ||
      runtime.version === "stale" ||
      (mode !== "legacy" && !output.includes(mode === "stdio" ? "serverInfo" : "version"))
    )
      throw Error("Wake/handshake failed: " + errorOutput);
    const result = {
      ready: true,
      mode,
      pid: runtime.pid,
      data,
      root,
      taskPrefix:
        "AyanamiTaskManager-Wake-" +
        createHash("sha256").update(path.resolve(data).toLowerCase()).digest("hex").slice(0, 16) +
        "-",
    };
    fs.writeFileSync(path.join(root, "ready.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ error: String(error).slice(0, 1000), root }));
  }
});
