import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("打包 stdio bridge", () => {
  it("按启动参数固定转发到 memory Profile", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-stdio-profile-"));
    temporary.push(dataDir);
    const runtimeDir = join(dataDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });

    let requestedUrl = "";
    let authorization = "";
    const server = createServer((request, response) => {
      requestedUrl = request.url ?? "";
      authorization = String(request.headers.authorization ?? "");
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } }));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
    writeFileSync(
      join(runtimeDir, "daemon.json"),
      JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}`, token: "profile-token" }),
      "utf8",
    );

    const bridge = join(process.cwd(), "apps", "desktop", "resources", "mcp-stdio.cjs");
    const child = spawn(process.execPath, [bridge, "--profile", "memory"], {
      env: { ...process.env, ATM_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = new Promise<string>((resolveOutput, rejectOutput) => {
      const timer = setTimeout(
        () => rejectOutput(new Error("stdio bridge response timeout")),
        5000,
      );
      child.stdout.once("data", (chunk: Buffer) => {
        clearTimeout(timer);
        resolveOutput(chunk.toString("utf8"));
      });
      child.once("error", rejectOutput);
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} })}\n`,
    );

    expect(JSON.parse((await output).trim())).toMatchObject({ id: 7, result: { ok: true } });
    expect({ requestedUrl, authorization }).toEqual({
      requestedUrl: "/mcp/memory",
      authorization: "Bearer profile-token",
    });

    child.kill();
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });
});
