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

function runtimeDescriptor(endpoint: string, token: string): Record<string, unknown> {
  return {
    endpoint,
    token,
    pid: process.pid,
    instanceId: "0123456789abcdef0123456789abcdef",
    version: "9.9.9",
    startedAt: "2026-08-28T12:00:00.000Z",
  };
}

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
      JSON.stringify(runtimeDescriptor(`http://127.0.0.1:${address.port}`, "profile-token")),
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

  it("未提供 --profile 时转发到带迁移提示的 legacy 兼容入口", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-stdio-default-profile-"));
    temporary.push(dataDir);
    const runtimeDir = join(dataDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });

    let requestedUrl = "";
    const server = createServer((request, response) => {
      requestedUrl = request.url ?? "";
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 8, result: { ok: true } }));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
    writeFileSync(
      join(runtimeDir, "daemon.json"),
      JSON.stringify(runtimeDescriptor(`http://127.0.0.1:${address.port}`, "profile-token")),
      "utf8",
    );

    const bridge = join(process.cwd(), "apps", "desktop", "resources", "mcp-stdio.cjs");
    const child = spawn(process.execPath, [bridge], {
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
      `${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} })}\n`,
    );

    expect(JSON.parse((await output).trim())).toMatchObject({ id: 8, result: { ok: true } });
    expect(requestedUrl).toBe("/mcp");

    child.kill();
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it("长寿命 bridge 在 daemon 重启后为下一请求重读唯一 runtime descriptor", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-stdio-runtime-reload-"));
    temporary.push(dataDir);
    const runtimeDir = join(dataDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const observed: Array<{ port: number; authorization: string }> = [];
    const createRuntimeServer = async (token: string) => {
      const server = createServer((request, response) => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("TEST_ADDRESS_MISSING");
        observed.push({
          port: address.port,
          authorization: String(request.headers.authorization ?? ""),
        });
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.once("end", () => {
          const message = JSON.parse(body) as { id: number };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }));
        });
      });
      await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TEST_ADDRESS_MISSING");
      return { server, port: address.port, token };
    };
    const first = await createRuntimeServer("first-token");
    const second = await createRuntimeServer("second-token");
    const writeRuntime = (runtime: { port: number; token: string }) =>
      writeFileSync(
        join(runtimeDir, "daemon.json"),
        JSON.stringify(runtimeDescriptor(`http://127.0.0.1:${runtime.port}`, runtime.token)),
        "utf8",
      );
    writeRuntime(first);

    const bridge = join(process.cwd(), "apps", "desktop", "resources", "mcp-stdio.cjs");
    const child = spawn(process.execPath, [bridge, "--profile", "core"], {
      env: { ...process.env, ATM_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let buffer = "";
    const pending = new Map<number, (value: { id: number }) => void>();
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id: number };
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });
    const request = (id: number) =>
      new Promise<{ id: number }>((resolveResponse, rejectResponse) => {
        const timer = setTimeout(() => rejectResponse(new Error(`bridge timeout: ${id}`)), 5000);
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolveResponse(value);
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} })}\n`,
        );
      });

    expect((await request(11)).id).toBe(11);
    writeRuntime(second);
    expect((await request(12)).id).toBe(12);
    expect(observed).toEqual([
      { port: first.port, authorization: "Bearer first-token" },
      { port: second.port, authorization: "Bearer second-token" },
    ]);

    child.kill();
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    await Promise.all(
      [first.server, second.server].map(
        (server) => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      ),
    );
  });

  it("descriptor 延迟出现时保留 bridge 并在发布后完成首次请求", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-stdio-runtime-wait-"));
    temporary.push(dataDir);
    const runtimeDir = join(dataDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer delayed-token");
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 13, result: { ready: true } }));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_ADDRESS_MISSING");

    const bridge = join(process.cwd(), "apps", "desktop", "resources", "mcp-stdio.cjs");
    const child = spawn(process.execPath, [bridge, "--profile", "actions"], {
      env: { ...process.env, ATM_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = new Promise<string>((resolveOutput, rejectOutput) => {
      const timer = setTimeout(() => rejectOutput(new Error("delayed runtime timeout")), 5000);
      child.stdout.once("data", (chunk: Buffer) => {
        clearTimeout(timer);
        resolveOutput(chunk.toString("utf8"));
      });
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 13, method: "tools/list", params: {} })}\n`,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    writeFileSync(
      join(runtimeDir, "daemon.json"),
      JSON.stringify(runtimeDescriptor(`http://127.0.0.1:${address.port}`, "delayed-token")),
      "utf8",
    );

    expect(JSON.parse((await output).trim())).toMatchObject({ id: 13, result: { ready: true } });
    child.kill();
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it("非法 --profile 大声失败并以非零状态退出", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-stdio-invalid-profile-"));
    temporary.push(dataDir);
    const runtimeDir = join(dataDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "daemon.json"),
      JSON.stringify(runtimeDescriptor("http://127.0.0.1:1", "profile-token")),
      "utf8",
    );

    const bridge = join(process.cwd(), "apps", "desktop", "resources", "mcp-stdio.cjs");
    const child = spawn(process.execPath, [bridge, "--profile", "merged"], {
      env: { ...process.env, ATM_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill();
        rejectExit(new Error("invalid profile process timeout"));
      }, 5000);
      child.once("error", rejectExit);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("MCP_PROFILE_INVALID");
  });
});
