import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { HostControlSession } from "../src/host-control-session.js";
import {
  HOST_PROTOCOL_VERSION,
  LineSplitter,
  MAX_FRAME_BYTES,
  parseHostFrame,
  toCoreError,
} from "../src/host-protocol.js";

const hello = {
  t: "hello",
  v: HOST_PROTOCOL_VERSION,
  runId: "run-1",
  version: "2.0.0",
  launch: { background: false, agentWake: false, randomStartupDelay: false },
};

describe("host-control 帧解析", () => {
  it("只认白名单方法与固定事件，字段越界即拒绝", () => {
    expect(parseHostFrame(JSON.stringify(hello)).t).toBe("hello");
    expect(
      parseHostFrame(JSON.stringify({ t: "req", id: 1, method: "runtimeRequest", args: [{}] })),
    ).toMatchObject({ method: "runtimeRequest" });
    for (const bad of [
      { t: "req", id: 1, method: "eval", args: [] },
      { t: "req", id: 1, method: "copyText", args: [] },
      { t: "req", id: -1, method: "runtimeRequest", args: [] },
      { t: "req", id: 1.5, method: "runtimeRequest", args: [] },
      { t: "req", id: 1, method: "runtimeRequest", args: [1, 2, 3, 4, 5] },
      { t: "req", id: 1, method: "runtimeRequest" },
      { t: "event", name: "open-devtools" },
      { ...hello, v: 2 },
      { ...hello, launch: { background: "yes" } },
      { ...hello, runId: "x".repeat(65) },
      { t: "nope" },
      [],
    ])
      expect(() => parseHostFrame(JSON.stringify(bad))).toThrow();
    expect(() => parseHostFrame("{not json")).toThrow(/JSON/u);
  });

  it("超长的行不等换行就拒绝，不先攒进内存", () => {
    const splitter = new LineSplitter(16);
    expect(splitter.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(":2}\r\n")).toEqual(['{"b":2}']);
    expect(() => splitter.push("x".repeat(17))).toThrow(/上限/u);
    expect(MAX_FRAME_BYTES).toBe(4 * 1024 * 1024);
  });

  it("错误跨 JSON 保真：code 前缀、details 与 report 都带过去", () => {
    expect(toCoreError(new Error("MCP_CLIENT_UNSUPPORTED"))).toMatchObject({
      code: "MCP_CLIENT_UNSUPPORTED",
    });
    const partial = Object.assign(new Error("部分客户端失败"), {
      code: "PROFILE_SWITCH_PARTIAL",
      report: { status: "PARTIAL" },
    });
    expect(toCoreError(partial)).toEqual({
      code: "PROFILE_SWITCH_PARTIAL",
      message: "部分客户端失败",
      details: { status: "PARTIAL" },
    });
    expect(toCoreError("boom").code).toBe("CORE_METHOD_FAILED");
  });
});

function session(onHello = vi.fn(async () => undefined)) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: unknown[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    for (const line of chunk.split("\n").filter(Boolean)) frames.push(JSON.parse(line));
  });
  const onClose = vi.fn();
  const control = new HostControlSession({
    input,
    output,
    onHello,
    onClose,
    handshakeTimeoutMs: 200,
    requestTimeoutMs: 100,
  });
  const send = (frame: unknown) => input.write(`${JSON.stringify(frame)}\n`);
  return { control, input, frames, onClose, onHello, send };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("host-control 会话", () => {
  it("握手通过之前的请求直接断开，方法不会执行", async () => {
    const { control, send, onClose } = session();
    const handler = vi.fn(() => "secret");
    control.handle("getMemoryProfile", handler);
    control.start();
    send({ t: "req", id: 1, method: "getMemoryProfile", args: [] });
    await settle();
    expect(handler).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("protocol-error");
  });

  it("握手校验失败（例如父进程不可信）即断开，之后的请求不执行", async () => {
    const { control, send, onClose } = session(vi.fn(async () => Promise.reject(new Error("no"))));
    const handler = vi.fn();
    control.handle("getMemoryProfile", handler);
    control.start();
    send(hello);
    send({ t: "req", id: 1, method: "getMemoryProfile", args: [] });
    await settle();
    expect(handler).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("protocol-error");
  });

  it("超时没有握手即关闭", async () => {
    const { control, onClose } = session();
    control.start();
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(onClose).toHaveBeenCalledWith("handshake-timeout");
  });

  it("握手后按 id 回包；方法抛错带 code；超时回 CORE_METHOD_TIMEOUT；未注册回 UNAVAILABLE", async () => {
    const { control, send, frames } = session();
    control.handle("getMemoryProfile", () => true);
    control.handle("installMcp", () => {
      throw new Error("MCP_CLIENT_UNSUPPORTED");
    });
    control.handle("checkForUpdates", () => new Promise(() => undefined));
    control.start();
    send(hello);
    await settle();
    send({ t: "req", id: 7, method: "getMemoryProfile", args: [] });
    send({ t: "req", id: 8, method: "installMcp", args: ["X"] });
    send({ t: "req", id: 9, method: "checkForUpdates", args: [] });
    send({ t: "req", id: 10, method: "getMcpBridges", args: [] });
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(frames).toEqual(
      expect.arrayContaining([
        { t: "res", id: 7, ok: true, value: true },
        expect.objectContaining({
          id: 8,
          ok: false,
          error: expect.objectContaining({ code: "MCP_CLIENT_UNSUPPORTED" }),
        }),
        expect.objectContaining({
          id: 9,
          ok: false,
          error: expect.objectContaining({ code: "CORE_METHOD_TIMEOUT" }),
        }),
        expect.objectContaining({
          id: 10,
          ok: false,
          error: expect.objectContaining({ code: "CORE_METHOD_UNAVAILABLE" }),
        }),
      ]),
    );
  });

  it("注册表只收白名单方法；重复注册报错", () => {
    const { control } = session();
    expect(() => control.handle("eval", () => undefined)).toThrow(/UNKNOWN/u);
    control.handle("getMemoryProfile", () => true);
    expect(() => control.handle("getMemoryProfile", () => true)).toThrow(/DUPLICATE/u);
  });

  it("管道断开与 shutdown 帧都关闭会话，只关一次", async () => {
    const first = session();
    first.control.start();
    first.send(hello);
    await settle();
    first.send({ t: "shutdown" });
    first.input.end();
    await settle();
    expect(first.onClose).toHaveBeenCalledTimes(1);
    expect(first.onClose).toHaveBeenCalledWith("shutdown");

    const second = session();
    second.control.start();
    second.input.end();
    await settle();
    expect(second.onClose).toHaveBeenCalledWith("disconnected");
  });
});
