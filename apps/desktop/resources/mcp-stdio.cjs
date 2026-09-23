"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const { existsSync, readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { join } = require("node:path");

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

/**
 * Starting the desktop as a detached child does NOT guarantee it outlives an Agent
 * host that closes a kill-on-close Job: on Windows the child stays in the host's Job.
 * A woken ATM can therefore end with the Agent that woke it. Registering a Task
 * Scheduler entry avoids that, but it is indistinguishable from malware persistence
 * (Kaspersky flags it as PDM:Trojan.Win32.Generic), so this launcher stays direct.
 * A desktop started at login or from the Start menu is not affected either way.
 */
function wakeDesktop(options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const env = { ...(options.env ?? process.env) };
  if (!/AyanamiTaskManager\.exe$/i.test(execPath)) return;
  delete env.ELECTRON_RUN_AS_NODE;
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
        wakeDesktop();
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

// Exported so the CLI can share one launcher. The require.main guard keeps the
// stdio loop from stealing a requiring process's stdin/stdout.
module.exports = { wakeDesktop };

if (require.main === module)
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
