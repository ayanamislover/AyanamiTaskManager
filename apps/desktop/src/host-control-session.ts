import type { Readable, Writable } from "node:stream";
import {
  CORE_METHODS,
  encodeCoreFrame,
  HANDSHAKE_TIMEOUT_MS,
  HostProtocolError,
  LineSplitter,
  MAX_FRAME_BYTES,
  MAX_IN_FLIGHT,
  MAX_RESPONSE_BYTES,
  parseHostFrame,
  REQUEST_TIMEOUT_MS,
  toCoreError,
  type CoreFrame,
  type CoreMethod,
  type HostEvent,
  type HostHello,
} from "./host-protocol.js";

export type CoreMethodHandler = (...args: unknown[]) => unknown;

export type HostControlSessionOptions = {
  input: Readable;
  output: Writable;
  /** 握手帧到了之后调用；返回的 Promise 失败即拒绝会话（例如父进程校验不通过）。 */
  onHello(hello: HostHello): Promise<void>;
  onEvent?(event: HostEvent): void;
  /** 宿主要求退出，或管道断开。只会调用一次。 */
  onClose(reason: "shutdown" | "disconnected" | "protocol-error" | "handshake-timeout"): void;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
};

/**
 * host-control 会话：握手 → 请求/响应 → 关闭。
 *
 * 握手通过之前，任何请求都直接判协议错误并断开——「验证完成前不能执行方法」
 * （r2 A1）。协议错误一律断开而不是尽量兼容：对端要么是我们自己的宿主，
 * 要么不该和 core 说话。
 */
export class HostControlSession {
  private readonly handlers = new Map<CoreMethod, CoreMethodHandler>();
  private readonly splitter = new LineSplitter(MAX_FRAME_BYTES);
  private state: "awaiting-hello" | "verifying" | "open" | "closed" = "awaiting-hello";
  private inFlight = 0;
  private handshakeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: HostControlSessionOptions) {}

  handle(method: string, handler: CoreMethodHandler): void {
    if (!(CORE_METHODS as readonly string[]).includes(method))
      throw new Error(`CORE_METHOD_UNKNOWN: ${method}`);
    if (this.handlers.has(method as CoreMethod))
      throw new Error(`CORE_METHOD_DUPLICATE: ${method}`);
    this.handlers.set(method as CoreMethod, handler);
  }

  get open(): boolean {
    return this.state === "open";
  }

  get closed(): boolean {
    return this.state === "closed";
  }

  start(): void {
    this.handshakeTimer = setTimeout(
      () => this.close("handshake-timeout"),
      this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    );
    this.options.input.setEncoding("utf8");
    this.options.input.on("data", (chunk: string) => this.receive(chunk));
    this.options.input.on("end", () => this.close("disconnected"));
    this.options.input.on("error", () => this.close("disconnected"));
    this.options.output.on("error", () => this.close("disconnected"));
  }

  send(frame: CoreFrame): void {
    if (this.state === "closed") return;
    const line = encodeCoreFrame(frame);
    this.options.output.write(line);
  }

  close(reason: "shutdown" | "disconnected" | "protocol-error" | "handshake-timeout"): void {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.options.onClose(reason);
  }

  private receive(chunk: string): void {
    if (this.state === "closed") return;
    let lines: string[];
    try {
      lines = this.splitter.push(chunk);
    } catch {
      this.close("protocol-error");
      return;
    }
    for (const line of lines) {
      if (this.closed) return;
      this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let frame;
    try {
      frame = parseHostFrame(line);
    } catch {
      this.close("protocol-error");
      return;
    }
    if (frame.t === "hello") {
      if (this.state !== "awaiting-hello") {
        this.close("protocol-error");
        return;
      }
      this.state = "verifying";
      this.options.onHello(frame).then(
        () => {
          if (this.state !== "verifying") return;
          if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
          this.handshakeTimer = null;
          this.state = "open";
        },
        () => this.close("protocol-error"),
      );
      return;
    }
    if (this.state !== "open") {
      this.close("protocol-error");
      return;
    }
    if (frame.t === "shutdown") {
      this.close("shutdown");
      return;
    }
    if (frame.t === "event") {
      this.options.onEvent?.(frame);
      return;
    }
    void this.execute(frame.id, frame.method, frame.args);
  }

  private async execute(id: number, method: CoreMethod, args: unknown[]): Promise<void> {
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.send({ t: "res", id, ok: false, error: { code: "CORE_BUSY", message: "在途请求过多" } });
      return;
    }
    const handler = this.handlers.get(method);
    if (!handler) {
      this.send({
        t: "res",
        id,
        ok: false,
        error: { code: "CORE_METHOD_UNAVAILABLE", message: `${method} 当前不可用` },
      });
      return;
    }
    this.inFlight += 1;
    let timer: NodeJS.Timeout | null = null;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new HostProtocolError("CORE_METHOD_TIMEOUT", `${method} 超时`)),
          this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        );
      });
      const value = await Promise.race([Promise.resolve().then(() => handler(...args)), timeout]);
      const frame: CoreFrame = {
        t: "res",
        id,
        ok: true,
        value: value === undefined ? null : value,
      };
      if (Buffer.byteLength(encodeCoreFrame(frame), "utf8") > MAX_RESPONSE_BYTES) {
        this.send({
          t: "res",
          id,
          ok: false,
          error: { code: "CORE_RESPONSE_TOO_LARGE", message: "响应超过上限" },
        });
      } else this.send(frame);
    } catch (error) {
      this.send({ t: "res", id, ok: false, error: toCoreError(error) });
    } finally {
      if (timer) clearTimeout(timer);
      this.inFlight -= 1;
    }
  }
}
