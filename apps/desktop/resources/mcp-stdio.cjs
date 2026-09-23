"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const { existsSync, readFileSync } = require("node:fs");
const { spawn, execFile, execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createInterface } = require("node:readline");
const { join, resolve } = require("node:path");

function dataDirectory() {
  if (process.env.ATM_DATA_DIR) return process.env.ATM_DATA_DIR;
  const base = process.env.LOCALAPPDATA;
  if (!base) throw new Error("找不到 LOCALAPPDATA；请设置 ATM_DATA_DIR");
  return join(base, "AyanamiTaskManager");
}

function runtime() {
  const path = join(dataDirectory(), "runtime", "daemon.json");
  if (!existsSync(path)) throw new Error("AyanamiTaskManager 服务未运行");
  let current;
  try {
    current = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("ATM_RUNTIME_DESCRIPTOR_INVALID");
  }
  const endpoint = new URL(current.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    typeof current.token !== "string" ||
    !current.token ||
    current.token.length > 512 ||
    !Number.isSafeInteger(current.pid) ||
    current.pid <= 0 ||
    typeof current.instanceId !== "string" ||
    !/^[a-f0-9]{32}$/.test(current.instanceId) ||
    typeof current.version !== "string" ||
    !current.version ||
    typeof current.startedAt !== "string" ||
    !Number.isFinite(Date.parse(current.startedAt))
  )
    throw new Error("ATM_RUNTIME_DESCRIPTOR_INVALID");
  return current;
}

// PowerShell also ends single-quoted strings at typographic quotes (U+2018-U+201B),
// so escaping ASCII quotes is not enough for a user-profile path. Base64 has no
// quote characters at all; the script decodes it back to the exact text.
function powershellText(value) {
  const encoded = Buffer.from(String(value), "utf8").toString("base64");
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`;
}

// One task per data root and Windows user. Registration and uninstall must agree.
function wakeTaskNameScript(dataDir) {
  const suffix = createHash("sha256")
    .update(resolve(dataDir).toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$name='AyanamiTaskManager-Wake-${suffix}-'+$identity.User.Value`;
}

function scheduledWakeScript(execPath, dataDir, environment = process.env) {
  const launchEnv = { ATM_DATA_DIR: resolve(dataDir) };
  // Explicit paths/flags only. Never persist the caller's credentials, token,
  // ELECTRON_RUN_AS_NODE or the rest of its environment in a scheduled task.
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    if (environment[key]) launchEnv[key] = environment[key];
  }
  if (environment.ATM_PACKAGED_SMOKE === "1") {
    for (const key of [
      "ATM_PACKAGED_SMOKE",
      "ATM_SMOKE_AGENT_CONFIG_ROOT",
      "ATM_SMOKE_MCP_CONFIG_REPAIR",
    ]) {
      if (environment[key]) launchEnv[key] = environment[key];
    }
  }
  const context = Buffer.from(JSON.stringify(launchEnv), "utf8").toString("base64");
  let args = `--background --agent-wake --atm-launch-context=${context}`;
  if (environment.ATM_PACKAGED_SMOKE === "1" && environment.ATM_WAKE_USER_DATA_DIR) {
    const profile = resolve(environment.ATM_WAKE_USER_DATA_DIR);
    if (/["\r\n\0]/.test(profile)) throw new Error("ATM_WAKE_PROFILE_INVALID");
    args += ` --user-data-dir="${profile.replace(/\\$/u, "\\\\")}"`;
  }
  return `$ErrorActionPreference='Stop'
$svc=New-Object -ComObject 'Schedule.Service'
$svc.Connect()
$root=$svc.GetFolder('\\')
${wakeTaskNameScript(dataDir)}
$definition=$svc.NewTask(0)
$definition.RegistrationInfo.Description='ATM current-user on-demand background launch; no automatic triggers'
$definition.Principal.UserId=$identity.Name
$definition.Principal.LogonType=3
$definition.Principal.RunLevel=0
$definition.Settings.Enabled=$true
$definition.Settings.AllowDemandStart=$true
$definition.Settings.DisallowStartIfOnBatteries=$false
$definition.Settings.StopIfGoingOnBatteries=$false
$definition.Settings.ExecutionTimeLimit='PT0S'
$definition.Settings.MultipleInstances=2
$definition.Settings.Priority=4
$action=$definition.Actions.Create(0)
$action.Path=${powershellText(execPath)}
$action.Arguments=${powershellText(args)}
$task=$root.RegisterTaskDefinition($name,$definition,6,$null,$null,3)
[void]$task.Run($null)
[Console]::Out.Write($name)
`;
}

// Uninstall removes the on-demand task it created; the task has no triggers, so
// leaving it would only keep a dead entry pointing at a deleted executable.
function wakeTaskRemovalScript(dataDir) {
  return `$ErrorActionPreference='Stop'
$svc=New-Object -ComObject 'Schedule.Service'
$svc.Connect()
$root=$svc.GetFolder('\\')
${wakeTaskNameScript(dataDir)}
try { [void]$root.GetTask($name) } catch { [Console]::Out.Write('absent'); return }
$root.DeleteTask($name,0)
[Console]::Out.Write('removed')
`;
}

function powershellPath() {
  return join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function powershellArgs(script) {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

function removeWakeTaskSync(options = {}) {
  if (process.platform !== "win32") return { outcome: "unsupported" };
  const dataDir = options.dataDir ?? dataDirectory();
  const output = execFileSync(powershellPath(), powershellArgs(wakeTaskRemovalScript(dataDir)), {
    // PowerShell writes module-loading progress as CLIXML on stderr; only stdout matters.
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 16_384,
    encoding: "utf8",
  });
  return { outcome: output.trim() };
}

async function wakeDesktop(options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const dataDir = options.dataDir ?? dataDirectory();
  const env = { ...(options.env ?? process.env) };
  if (!/AyanamiTaskManager\.exe$/i.test(execPath)) return;
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform === "win32") {
    const script = scheduledWakeScript(execPath, dataDir, env);
    return new Promise((resolveWake, rejectWake) => {
      execFile(
        powershellPath(),
        powershellArgs(script),
        { windowsHide: true, timeout: 15_000, maxBuffer: 16_384 },
        (error, stdout) => {
          if (error)
            rejectWake(
              new Error(
                "ATM_INDEPENDENT_WAKE_FAILED: Windows Task Scheduler rejected the current-user launch; start ATM from the Start menu and check Task Scheduler permissions. No unsafe fallback was used.",
              ),
            );
          else resolveWake({ taskName: stdout.trim() });
        },
      );
    });
  }
  const child = spawn(execPath, ["--background", "--agent-wake"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
}

async function waitForRuntime(waitMs = 45_000, stale = null) {
  const deadline = Date.now() + waitMs;
  let wakeRequested = false;
  while (true) {
    try {
      const current = runtime();
      // The caller already saw this instance refuse connections. Its PID may now
      // belong to an unrelated process, so only a newly published instance counts.
      if (stale && current.instanceId === stale.instanceId)
        throw new Error("ATM_RUNTIME_UNAVAILABLE");
      // A forced host termination leaves the descriptor behind. Do not treat
      // its mere presence as a live service, or the next Agent cannot wake ATM.
      try {
        process.kill(current.pid, 0);
      } catch (error) {
        if (error.code !== "EPERM") throw new Error("ATM_RUNTIME_UNAVAILABLE");
      }
      return current;
    } catch (error) {
      if (error instanceof Error && error.message === "ATM_RUNTIME_DESCRIPTOR_INVALID") throw error;
      if (!wakeRequested) {
        wakeRequested = true;
        await wakeDesktop();
      }
      if (Date.now() >= deadline) throw new Error("ATM_RUNTIME_UNAVAILABLE");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

// Only a refused connection proves the request never reached a daemon, so only
// that case may be retried. Resets or timeouts could follow a delivered request.
function connectionRefused(error) {
  const cause = error && typeof error === "object" ? error.cause : undefined;
  if (!cause || typeof cause !== "object") return false;
  if (cause.code === "ECONNREFUSED") return true;
  return (
    Array.isArray(cause.errors) &&
    cause.errors.length > 0 &&
    cause.errors.every((item) => item && item.code === "ECONNREFUSED")
  );
}

function profile(args = process.argv.slice(2)) {
  const index = args.indexOf("--profile");
  if (index < 0) return null;
  const selected = args[index + 1];
  if (selected !== "core" && selected !== "memory" && selected !== "actions")
    throw new Error("MCP_PROFILE_INVALID: expected core, memory or actions");
  return selected;
}

async function main() {
  const selectedProfile = profile();
  const mcpPath = selectedProfile === null ? "/mcp" : `/mcp/${selectedProfile}`;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null })}\n`,
      );
      continue;
    }
    try {
      // Re-read the single discovery source for every request. A long-lived
      // bridge therefore follows an app restart instead of retaining a stale
      // endpoint/token pair from process startup.
      const forward = (current) =>
        fetch(`${current.endpoint.replace(/\/$/, "")}${mcpPath}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${current.token}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(message),
        });
      const current = await waitForRuntime();
      let response;
      try {
        response = await forward(current);
      } catch (error) {
        if (!connectionRefused(error)) throw error;
        // Nothing listens on the recorded endpoint: the descriptor outlived its
        // daemon even if the PID looks alive. Wake ATM and retry exactly once.
        response = await forward(await waitForRuntime(45_000, current));
      }
      if (response.status === 202 || response.status === 204) continue;
      const text = await response.text();
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        for (const entry of text.split(/\r?\n/)) {
          if (entry.startsWith("data:") && entry.slice(5).trim())
            process.stdout.write(`${entry.slice(5).trim()}\n`);
        }
      } else if (text.trim()) {
        process.stdout.write(`${JSON.stringify(JSON.parse(text))}\n`);
      }
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : "MCP proxy error",
          },
          id:
            message && typeof message === "object" && "id" in message ? (message.id ?? null) : null,
        })}\n`,
      );
    }
  }
}

module.exports = { wakeDesktop, scheduledWakeScript, wakeTaskRemovalScript, removeWakeTaskSync };

if (require.main === module)
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
