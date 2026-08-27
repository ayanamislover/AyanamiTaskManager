"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const { existsSync, readFileSync } = require("node:fs");
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
  return JSON.parse(readFileSync(path, "utf8"));
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
  const current = runtime();
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
      const response = await fetch(`${current.endpoint.replace(/\/$/, "")}${mcpPath}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${current.token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(message),
      });
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

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
