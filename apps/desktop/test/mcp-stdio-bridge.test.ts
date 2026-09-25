import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { createRequire } from "node:module";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureNativeShim, SHIM_CRATE, SHIM_EXE, WAKE_RECORDER_EXE } from "./native-shim.js";

/**
 * One stdio contract, two implementations. The native shim replaces the JavaScript
 * bridge on every Agent session, so anything a client or the daemon can observe is
 * asserted against both from the same test body; a case that only one of them passes
 * is a behaviour change, not a detail.
 */
const JS_BRIDGE = join(process.cwd(), "apps", "desktop", "resources", "mcp-stdio.cjs");

type Implementation = {
  name: string;
  prepare(): void;
  command(): string;
  args(extra: string[]): string[];
};

const implementations: Implementation[] = [
  {
    name: "JS bridge (mcp-stdio.cjs)",
    prepare: () => undefined,
    command: () => process.execPath,
    args: (extra) => [JS_BRIDGE, ...extra],
  },
  {
    name: "native shim (atm-mcp.exe)",
    prepare: () => void ensureNativeShim(),
    command: () => SHIM_EXE,
    args: (extra) => extra,
  },
];

const temporary: string[] = [];
const children: ChildProcess[] = [];
const httpServers: Server[] = [];
const tcpServers: TcpServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  // Children first: a running exe inside a fixture directory keeps it from being deleted.
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolveExit) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
          child.once("exit", () => resolveExit());
          child.kill();
        }),
    ),
  );
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all([
    ...httpServers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.closeAllConnections();
          server.close(() => resolveClose());
        }),
    ),
    ...tcpServers
      .splice(0)
      .map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))),
  ]);
  // A woken recorder may still be running from its fixture directory for a moment after it
  // wrote its record; on Windows deleting it is EPERM. Retry, and never let one directory
  // abort the loop: that is how a data directory once leaked into %TEMP%.
  const failures: unknown[] = [];
  for (const directory of temporary.splice(0)) {
    try {
      await removeFixture(directory);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      `fixture cleanup failed: ${failures.map(String).join("; ")}`,
    );
});

/**
 * rmSync with retries done here: Node 24's native recursive rm reports a busy file as
 * EPERM and does not honour maxRetries for it, so the option alone gives up at once.
 */
async function removeFixture(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const { code, message } = error as NodeJS.ErrnoException;
      if (attempt >= 50 || !/\b(?:EPERM|EBUSY|ENOTEMPTY)\b/u.test(code ?? message)) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
}

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

function dataDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `atm-stdio-${label}-`));
  temporary.push(dir);
  mkdirSync(join(dir, "runtime"), { recursive: true });
  return dir;
}

function publish(
  dir: string,
  endpoint: string,
  token: string,
  overrides: Record<string, unknown> = {},
): void {
  writeFileSync(
    join(dir, "runtime", "daemon.json"),
    JSON.stringify({ ...runtimeDescriptor(endpoint, token), ...overrides }),
    "utf8",
  );
}

async function listen(handler: RequestListener): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  httpServers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
  return { server, port: address.port };
}

/** A port that was just released: connecting to it is refused. */
async function closedPort(): Promise<number> {
  const closed = createServer();
  await new Promise<void>((resolveListen) => closed.listen(0, "127.0.0.1", resolveListen));
  const address = closed.address();
  if (!address || typeof address === "string") throw new Error("TEST_ADDRESS_MISSING");
  await new Promise<void>((resolveClose) => closed.close(() => resolveClose()));
  return address.port;
}

function readBody(request: Parameters<RequestListener>[0]): Promise<string> {
  return new Promise((resolveBody) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.once("end", () => resolveBody(body));
  });
}

type Bridge = {
  child: ChildProcess;
  send(message: unknown): void;
  raw(text: string): void;
  next(timeoutMs?: number): Promise<string>;
  stderr(): string;
  exit(): Promise<number | null>;
};

function start(
  implementation: Implementation,
  extra: string[],
  env: NodeJS.ProcessEnv,
  stdin: "pipe" | "ignore" = "pipe",
): Bridge {
  const child = spawn(implementation.command(), implementation.args(extra), {
    env,
    stdio: [stdin, "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  const ready: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buffer = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else ready.push(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  return {
    child,
    send: (message) => child.stdin?.write(`${JSON.stringify(message)}\n`),
    raw: (text) => child.stdin?.write(text),
    next: (timeoutMs = 5000) => {
      const line = ready.shift();
      if (line !== undefined) return Promise.resolve(line);
      return new Promise((resolveLine, rejectLine) => {
        const timer = setTimeout(
          () =>
            rejectLine(
              new Error(`${implementation.name}: no stdout line in ${timeoutMs}ms; ${stderr}`),
            ),
          timeoutMs,
        );
        waiters.push((value) => {
          clearTimeout(timer);
          resolveLine(value);
        });
      });
    },
    stderr: () => stderr,
    exit: () =>
      new Promise((resolveExit) => {
        if (child.exitCode !== null) return resolveExit(child.exitCode);
        child.once("exit", (code) => resolveExit(code));
      }),
  };
}

const request = (id: unknown, method = "tools/list") => ({
  jsonrpc: "2.0",
  id,
  method,
  params: {},
});
const reply = (id: unknown, result: unknown = { ok: true }) =>
  JSON.stringify({ jsonrpc: "2.0", id, result });

describe.each(implementations)("stdio bridge contract: $name", (implementation) => {
  beforeAll(() => implementation.prepare(), 300_000);

  it("按启动参数固定转发到 memory Profile", async () => {
    const dir = dataDir("profile");
    let requestedUrl = "";
    let authorization = "";
    const { port } = await listen((incoming, response) => {
      requestedUrl = incoming.url ?? "";
      authorization = String(incoming.headers.authorization ?? "");
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(reply(7));
      });
    });
    publish(dir, `http://127.0.0.1:${port}`, "profile-token");

    const bridge = start(implementation, ["--profile", "memory"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send(request(7));

    expect(JSON.parse(await bridge.next())).toMatchObject({ id: 7, result: { ok: true } });
    expect({ requestedUrl, authorization }).toEqual({
      requestedUrl: "/mcp/memory",
      authorization: "Bearer profile-token",
    });
  });

  it("未提供 --profile 时转发到带迁移提示的 legacy 兼容入口", async () => {
    const dir = dataDir("default-profile");
    let requestedUrl = "";
    const { port } = await listen((incoming, response) => {
      requestedUrl = incoming.url ?? "";
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(reply(8));
      });
    });
    publish(dir, `http://127.0.0.1:${port}`, "profile-token");

    const bridge = start(implementation, [], { ...process.env, ATM_DATA_DIR: dir });
    bridge.send(request(8));

    expect(JSON.parse(await bridge.next())).toMatchObject({ id: 8, result: { ok: true } });
    expect(requestedUrl).toBe("/mcp");
  });

  it("长寿命 bridge 在 daemon 重启后为下一请求重读唯一 runtime descriptor", async () => {
    const dir = dataDir("runtime-reload");
    const observed: Array<{ port: number; authorization: string }> = [];
    const runtimeServer = async (token: string) => {
      const { server, port } = await listen((incoming, response) => {
        observed.push({ port, authorization: String(incoming.headers.authorization ?? "") });
        void readBody(incoming).then((body) => {
          const message = JSON.parse(body) as { id: number };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(reply(message.id));
        });
      });
      return { server, port, token };
    };
    const first = await runtimeServer("first-token");
    const second = await runtimeServer("second-token");
    publish(dir, `http://127.0.0.1:${first.port}`, first.token);

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send(request(11));
    expect(JSON.parse(await bridge.next()).id).toBe(11);
    publish(dir, `http://127.0.0.1:${second.port}`, second.token);
    bridge.send(request(12));
    expect(JSON.parse(await bridge.next()).id).toBe(12);
    expect(observed).toEqual([
      { port: first.port, authorization: "Bearer first-token" },
      { port: second.port, authorization: "Bearer second-token" },
    ]);
  });

  it("descriptor 延迟出现时保留 bridge 并在发布后完成首次请求", async () => {
    const dir = dataDir("runtime-wait");
    let authorization = "";
    const { port } = await listen((incoming, response) => {
      authorization = String(incoming.headers.authorization ?? "");
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(reply(13, { ready: true }));
      });
    });

    const bridge = start(implementation, ["--profile", "actions"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send(request(13));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    publish(dir, `http://127.0.0.1:${port}`, "delayed-token");

    expect(JSON.parse(await bridge.next())).toMatchObject({ id: 13, result: { ready: true } });
    expect(authorization).toBe("Bearer delayed-token");
  });

  it("非法 --profile 大声失败并以非零状态退出", async () => {
    const dir = dataDir("invalid-profile");
    publish(dir, "http://127.0.0.1:1", "profile-token");

    const bridge = start(
      implementation,
      ["--profile", "merged"],
      { ...process.env, ATM_DATA_DIR: dir },
      "ignore",
    );
    const exitCode = await Promise.race([
      bridge.exit(),
      new Promise<never>((_, rejectExit) =>
        setTimeout(() => rejectExit(new Error("invalid profile process timeout")), 5000),
      ),
    ]);

    expect(exitCode).not.toBe(0);
    expect(bridge.stderr()).toContain("MCP_PROFILE_INVALID");
  });

  it("残留 descriptor 的 PID 被别的进程复用时，连接被拒也会等新实例并重试一次", async () => {
    const dir = dataDir("reused-pid");
    // process.pid is alive but is not ATM: exactly the reused-PID situation.
    publish(dir, `http://127.0.0.1:${await closedPort()}`, "stale-token");
    let delivered = 0;
    let authorization = "";
    const { port } = await listen((incoming, response) => {
      delivered += 1;
      authorization = String(incoming.headers.authorization ?? "");
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(reply(21, { revived: true }));
      });
    });

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send(request(21));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    // The woken desktop publishes a new instance.
    publish(dir, `http://127.0.0.1:${port}`, "fresh-token", {
      instanceId: "fedcba9876543210fedcba9876543210",
    });

    expect(JSON.parse(await bridge.next())).toMatchObject({ id: 21, result: { revived: true } });
    expect(delivered).toBe(1);
    expect(authorization).toBe("Bearer fresh-token");
  });

  it("请求已送达后连接断开不重试，避免同一请求投递两次", async () => {
    const dir = dataDir("no-replay");
    let delivered = 0;
    const { port } = await listen((incoming) => {
      delivered += 1;
      incoming.resume();
      incoming.once("end", () => incoming.socket.destroy());
    });
    publish(dir, `http://127.0.0.1:${port}`, "reset-token");

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send(request(22, "tools/call"));

    expect(JSON.parse(await bridge.next())).toMatchObject({ id: 22, error: { code: -32000 } });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    expect(delivered).toBe(1);
  });

  it("SSE 响应逐条输出 data 行，忽略 event 行、空 data 与 CRLF", async () => {
    const dir = dataDir("sse");
    const { port } = await listen((incoming, response) => {
      void readBody(incoming).then((body) => {
        const { id } = JSON.parse(body) as { id: number };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `event: message\r\ndata: ${reply(id)}\r\n\r\n` +
            `event: message\ndata:${reply(id + 1000)}\n\n` +
            "data:   \n\n",
        );
      });
    });
    publish(dir, `http://127.0.0.1:${port}`, "sse-token");

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send(request(41));
    expect(await bridge.next()).toBe(reply(41));
    expect(await bridge.next()).toBe(reply(1041));
    // Nothing else was emitted for that response: the next line belongs to the next request.
    bridge.send(request(42));
    expect(await bridge.next()).toBe(reply(42));
  });

  it("202 / 204 不产生任何输出，后续请求照常应答", async () => {
    const dir = dataDir("no-content");
    const { port } = await listen((incoming, response) => {
      void readBody(incoming).then((body) => {
        const message = JSON.parse(body) as { id?: number };
        if (message.id === undefined) {
          // What the daemon really does for a notification: 202 with an empty chunked body.
          response.writeHead(202);
          response.end();
        } else if (message.id === 43) {
          response.writeHead(204);
          response.end();
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(reply(message.id));
        }
      });
    });
    publish(dir, `http://127.0.0.1:${port}`, "quiet-token");

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    bridge.send(request(43));
    bridge.send(request(44));
    expect(await bridge.next()).toBe(reply(44));
  });

  it("多行 JSON 响应压成单行，字面量原样保留", async () => {
    const dir = dataDir("compact");
    const { port } = await listen((incoming, response) => {
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          '{\n  "jsonrpc": "2.0",\n  "id": 31,\n  "result": { "s": "a  b", "n": [1, 2] }\n}\n',
        );
      });
    });
    publish(dir, `http://127.0.0.1:${port}`, "compact-token");

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send(request(31));
    expect(await bridge.next()).toBe('{"jsonrpc":"2.0","id":31,"result":{"s":"a  b","n":[1,2]}}');
  });

  it("分块传输的响应完整拼回", async () => {
    const dir = dataDir("chunked");
    const { port } = await listen((incoming, response) => {
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"jsonrpc":"2.0",');
        setTimeout(() => response.end('"id":32,"result":{"chunked":true}}'), 50);
      });
    });
    publish(dir, `http://127.0.0.1:${port}`, "chunked-token");

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send(request(32));
    expect(await bridge.next()).toBe(reply(32, { chunked: true }));
  });

  /**
   * The daemon's MCP transport answers `connection: keep-alive` and leaves the socket
   * open even when the request asks to close it. A bridge that reads the body to EOF
   * stalls on every request until the server's idle timeout (measured: over a minute).
   */
  it("服务端应答后不关连接（真实 daemon 行为）时立刻返回", async () => {
    const dir = dataDir("keep-alive");
    const server = createTcpServer((socket) => {
      sockets.push(socket);
      // The bridge closes or resets the connection this server keeps open; expected.
      socket.on("error", () => undefined);
      let received = "";
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        const headEnd = received.indexOf("\r\n\r\n");
        if (headEnd < 0) return;
        const length = Number(/content-length:\s*(\d+)/iu.exec(received.slice(0, headEnd))?.[1]);
        const body = received.slice(headEnd + 4);
        if (Buffer.byteLength(body) < length) return;
        const { id } = JSON.parse(body) as { id: number };
        const payload = `event: message\ndata: ${reply(id)}\n\n`;
        socket.write(
          "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: keep-alive\r\n" +
            `content-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
        );
        received = "";
        // Deliberately never ends the socket.
      });
    });
    tcpServers.push(server);
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_ADDRESS_MISSING");
    publish(dir, `http://127.0.0.1:${address.port}`, "keep-alive-token");

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send(request(33));
    expect(await bridge.next(2000)).toBe(reply(33));
    bridge.send(request(34));
    expect(await bridge.next(2000)).toBe(reply(34));
  });

  it("非 JSON 响应体报 -32000，并带回原请求的 id", async () => {
    const dir = dataDir("non-json");
    const { port } = await listen((incoming, response) => {
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end("Unauthorized");
      });
    });
    publish(dir, `http://127.0.0.1:${port}`, "wrong-token");

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send(request("abc"));
    expect(JSON.parse(await bridge.next())).toMatchObject({
      jsonrpc: "2.0",
      id: "abc",
      error: { code: -32000 },
    });
  });

  it("畸形输入报 -32700，且不影响下一条", async () => {
    const dir = dataDir("parse-error");
    const { port } = await listen((incoming, response) => {
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(reply(35));
      });
    });
    publish(dir, `http://127.0.0.1:${port}`, "parse-token");

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.raw("this is not json\n");
    bridge.send(request(35));
    expect(await bridge.next()).toBe(
      '{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}',
    );
    expect(await bridge.next()).toBe(reply(35));
  });

  it("空白行（含 BOM）直接跳过，CRLF 结尾照常解析", async () => {
    const dir = dataDir("whitespace");
    let delivered = 0;
    const { port } = await listen((incoming, response) => {
      delivered += 1;
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(reply(36));
      });
    });
    publish(dir, `http://127.0.0.1:${port}`, "ws-token");

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.raw(`\u{FEFF}  \t\r\n\r\n${JSON.stringify(request(36))}\r\n`);
    expect(await bridge.next()).toBe(reply(36));
    expect(delivered).toBe(1);
  });

  it("descriptor 非法时立即报错，不等 45 秒", async () => {
    const dir = dataDir("invalid-descriptor");
    publish(dir, "https://127.0.0.1:1", "tls-token");

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send(request(37));
    expect(await bridge.next(3000)).toBe(
      '{"jsonrpc":"2.0","error":{"code":-32000,"message":"ATM_RUNTIME_DESCRIPTOR_INVALID"},"id":37}',
    );
  });

  it("出错时通知与批量请求的 id 回 null", async () => {
    const dir = dataDir("null-id");
    publish(dir, "https://127.0.0.1:1", "tls-token");

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    bridge.send([request(38)]);
    for (let index = 0; index < 2; index++)
      expect(JSON.parse(await bridge.next(3000))).toMatchObject({
        error: { code: -32000 },
        id: null,
      });
  });

  it("单独的 CR 也是行尾（Node readline 语义）", async () => {
    const dir = dataDir("bare-cr");
    const { port } = await listen((incoming, response) => {
      void readBody(incoming).then((body) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(reply((JSON.parse(body) as { id: number }).id));
      });
    });
    publish(dir, `http://127.0.0.1:${port}`, "cr-token");

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.raw(`${JSON.stringify(request(61))}\r${JSON.stringify(request(62))}\n`);
    expect(await bridge.next()).toBe(reply(61));
    expect(await bridge.next()).toBe(reply(62));
  });

  /**
   * A descriptor left behind by a killed daemon names a PID that is gone. Its port may
   * since have been taken by an unrelated local server, which must never receive the
   * request or the bearer token: only a live PID's endpoint is contacted.
   */
  it("描述符里的 PID 已退出时，不向旧端口发送请求与令牌", async () => {
    const dir = dataDir("dead-pid");
    const exited = spawnSync("cmd.exe", ["/d", "/c", "exit 0"], { windowsHide: true });
    if (typeof exited.pid !== "number") throw new Error("TEST_DEAD_PID_MISSING");
    let squatterHits = 0;
    const squatter = await listen((incoming, response) => {
      squatterHits += 1;
      incoming.resume();
      incoming.once("end", () => response.end());
    });
    publish(dir, `http://127.0.0.1:${squatter.port}`, "secret-token", { pid: exited.pid });
    const daemon = await listen((incoming, response) => {
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(reply(63));
      });
    });

    const bridge = start(implementation, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
    });
    bridge.send(request(63));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    publish(dir, `http://127.0.0.1:${daemon.port}`, "fresh-token", {
      instanceId: "fedcba9876543210fedcba9876543210",
    });
    expect(await bridge.next()).toBe(reply(63));
    expect(squatterHits).toBe(0);
  });
});

/**
 * Waking the desktop. The JS bridge keys the wake off its own execPath (it runs as the
 * desktop exe), so it is driven through its exported `wakeDesktop` with an execPath
 * that points at the recorder; the shim is driven end to end from a layout that puts a
 * recorder where AyanamiTaskManager.exe would be. Both are held to the same record.
 *
 * Fixture executables live under the crate's target directory, never in %TEMP%.
 */
describe("waking the desktop", () => {
  beforeAll(() => void ensureNativeShim(), 300_000);

  function layout(label: string) {
    const root = join(SHIM_CRATE, "target", `contract-${label}-${process.pid}-${Date.now()}`);
    temporary.push(root);
    mkdirSync(join(root, "resources"), { recursive: true });
    const desktop = join(root, "AyanamiTaskManager.exe");
    copyFileSync(WAKE_RECORDER_EXE, desktop);
    return { root, desktop, record: join(root, "wake.ndjson") };
  }

  // A freshly copied executable can be slow on its first start (antivirus reputation
  // checks), hence the generous deadline. One unexplained miss was seen during mutation
  // runs and did not reproduce; the message carries what was on disk so a repeat is
  // diagnosable instead of anecdotal.
  async function records(path: string, count: number): Promise<Array<Record<string, unknown>>> {
    const read = () =>
      existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const lines = read() ?? [];
      if (lines.length >= count) return lines.map((line) => JSON.parse(line));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    const seen = read();
    throw new Error(
      `expected ${count} wake record(s) in ${path}; ` +
        (seen === null ? "file never created" : `saw ${JSON.stringify(seen)}`),
    );
  }

  it("JS bridge：以 --background --agent-wake 拉起桌面并剥掉 ELECTRON_RUN_AS_NODE", async () => {
    const { desktop, record } = layout("js");
    const dir = dataDir("wake-js");
    const { wakeDesktop } = createRequire(import.meta.url)(JS_BRIDGE) as {
      wakeDesktop(options: { execPath: string; env: NodeJS.ProcessEnv }): void;
    };
    wakeDesktop({
      execPath: desktop,
      env: {
        ...process.env,
        ATM_DATA_DIR: dir,
        ATM_WAKE_RECORD: record,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    expect(await records(record, 1)).toEqual([
      expect.objectContaining({
        args: ["--background", "--agent-wake"],
        electronRunAsNode: null,
        dataDir: dir,
      }),
    ]);
  });

  it("native shim：没有 daemon 时只唤醒一次同级桌面，发布后完成请求", async () => {
    const { root, record } = layout("shim");
    const shim = join(root, "resources", "atm-mcp.exe");
    copyFileSync(SHIM_EXE, shim);
    const dir = dataDir("wake-shim");
    const { port } = await listen((incoming, response) => {
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(reply(51));
      });
    });

    const bridge = start({ ...implementations[1]!, command: () => shim }, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
      ATM_WAKE_RECORD: record,
      ELECTRON_RUN_AS_NODE: "1",
    });
    bridge.send(request(51));
    const [woken] = await records(record, 1);
    expect(woken).toMatchObject({
      args: ["--background", "--agent-wake"],
      electronRunAsNode: null,
      dataDir: dir,
    });
    // It keeps polling every 100 ms; it must not keep relaunching the desktop.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
    expect(readFileSync(record, "utf8").split("\n").filter(Boolean)).toHaveLength(1);

    publish(dir, `http://127.0.0.1:${port}`, "woken-token");
    expect(await bridge.next()).toBe(reply(51));
  });

  it("native shim：目录布局里没有桌面 exe 时不唤醒任何东西", async () => {
    // target/release has no AyanamiTaskManager.exe one level up; nothing may be started.
    const dir = dataDir("wake-none");
    const record = join(dir, "wake.ndjson");
    const bridge = start(implementations[1]!, ["--profile", "core"], {
      ...process.env,
      ATM_DATA_DIR: dir,
      ATM_WAKE_RECORD: record,
    });
    bridge.send(request(52));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    expect(existsSync(record)).toBe(false);
  });
});
