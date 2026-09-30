/**
 * 宿主（Rust）与 core（Node）之间的 host-control 协议：core 的 stdin/stdout 上逐行 JSON。
 *
 * 这条管道是界面拿到用户权限的唯一通道（ATM-T-0520）：宿主把渲染器发来的 runtimeRequest
 * 交给 core，由 core 注入只在自己内存里的用户凭证。所以协议面只放界面真正需要的方法，
 * 每个参数逐个校验，任何越界一律拒绝，而不是尽量兼容。
 *
 * stdout 只写协议帧；诊断走 stderr。
 */

export const HOST_PROTOCOL_VERSION = 1;
/** 单帧上限。runtimeRequest 的 body 本身限 2 MiB（runtime-request.ts），留出 JSON 转义余量。 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** core → 宿主的单帧上限（列表类响应比请求大）。宿主按同一数字拒收。 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** 同时在途的请求数。渲染器正常情况下远低于此；超出说明对端失控。 */
export const MAX_IN_FLIGHT = 64;
export const REQUEST_TIMEOUT_MS = 30_000;
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** 渲染器桥里交给 core 的方法。窗口、剪贴板、打开路径、自启动由宿主本地处理，不在此列。 */
export const CORE_METHODS = [
  "runtimeRequest",
  "getUpdateStatus",
  "checkForUpdates",
  "getMcpConfigs",
  "getMcpBridges",
  "getMemoryProfile",
  "setMemoryProfile",
  "installMcp",
  "getAgentIntegrations",
  "manageAgentIntegration",
  "setNotificationMode",
] as const;
export type CoreMethod = (typeof CORE_METHODS)[number];

export type HostLaunch = {
  background: boolean;
  agentWake: boolean;
  randomStartupDelay: boolean;
};

export type HostHello = {
  t: "hello";
  v: number;
  /** 宿主本次启动的关联 id，只用于日志对齐，不作权限。 */
  runId: string;
  version: string;
  launch: HostLaunch;
};

export type HostRequest = {
  t: "req";
  id: number;
  method: CoreMethod;
  args: unknown[];
};

export type HostEvent =
  | { t: "event"; name: "renderer-ready" }
  | { t: "event"; name: "window-shown" }
  | { t: "event"; name: "window-closed" }
  | { t: "event"; name: "startup-delay-cancelled" };

export type HostShutdown = { t: "shutdown" };

export type HostFrame = HostHello | HostRequest | HostEvent | HostShutdown;

export type CoreError = { code: string; message: string; details?: unknown };

export type TraySnapshot = {
  blocked: number;
  waiting: number;
  pendingUpdate: string | null;
  notificationMode: "ALL" | "CRITICAL" | "OFF";
};

export type CoreFrame =
  | { t: "ready"; v: number; runId: string; version: string }
  | { t: "res"; id: number; ok: true; value: unknown }
  | { t: "res"; id: number; ok: false; error: CoreError }
  | { t: "tray"; snapshot: TraySnapshot }
  | { t: "notify"; title: string; body: string }
  | { t: "fatal"; code: string; message: string };

export class HostProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HostProtocolError";
  }
}

const HOST_EVENTS = new Set([
  "renderer-ready",
  "window-shown",
  "window-closed",
  "startup-delay-cancelled",
]);
const CORE_METHOD_SET = new Set<string>(CORE_METHODS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** 严格解析一帧；任何字段不合规都抛 HostProtocolError，调用方据此断开或回错。 */
export function parseHostFrame(line: string): HostFrame {
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES)
    throw new HostProtocolError("FRAME_TOO_LARGE", "host-control 帧超过上限");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new HostProtocolError("FRAME_INVALID_JSON", "host-control 帧不是 JSON");
  }
  if (!isRecord(value)) throw new HostProtocolError("FRAME_INVALID", "host-control 帧必须是对象");
  switch (value.t) {
    case "hello": {
      const launch = value.launch;
      if (
        value.v !== HOST_PROTOCOL_VERSION ||
        !boundedString(value.runId, 64) ||
        !boundedString(value.version, 64) ||
        !isRecord(launch) ||
        typeof launch.background !== "boolean" ||
        typeof launch.agentWake !== "boolean" ||
        typeof launch.randomStartupDelay !== "boolean"
      )
        throw new HostProtocolError("HELLO_INVALID", "握手帧不合规");
      return {
        t: "hello",
        v: value.v,
        runId: value.runId,
        version: value.version,
        launch: {
          background: launch.background,
          agentWake: launch.agentWake,
          randomStartupDelay: launch.randomStartupDelay,
        },
      };
    }
    case "req": {
      if (
        typeof value.id !== "number" ||
        !Number.isSafeInteger(value.id) ||
        value.id < 0 ||
        typeof value.method !== "string" ||
        !CORE_METHOD_SET.has(value.method) ||
        !Array.isArray(value.args) ||
        value.args.length > 4
      )
        throw new HostProtocolError("REQUEST_INVALID", "请求帧不合规");
      return { t: "req", id: value.id, method: value.method as CoreMethod, args: value.args };
    }
    case "event": {
      if (typeof value.name !== "string" || !HOST_EVENTS.has(value.name))
        throw new HostProtocolError("EVENT_INVALID", "事件帧不合规");
      return { t: "event", name: value.name } as HostEvent;
    }
    case "shutdown":
      return { t: "shutdown" };
    default:
      throw new HostProtocolError("FRAME_UNKNOWN", "未知的 host-control 帧");
  }
}

/** 序列化一帧。结果一定是单行（JSON.stringify 不输出裸换行）。 */
export function encodeCoreFrame(frame: CoreFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** 错误跨 JSON 保真：code/message/details（例如 profile 切换的 PARTIAL 报告）。 */
export function toCoreError(error: unknown): CoreError {
  if (error instanceof HostProtocolError) return { code: error.code, message: error.message };
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown; details?: unknown; report?: unknown };
    const code =
      typeof withCode.code === "string" && withCode.code.length <= 64
        ? withCode.code
        : (/^([A-Z][A-Z0-9_]{2,63})(?::|$)/u.exec(error.message)?.[1] ?? "CORE_METHOD_FAILED");
    const details = withCode.details ?? withCode.report;
    return {
      code,
      message: error.message.slice(0, 2000),
      ...(details === undefined ? {} : { details }),
    };
  }
  return { code: "CORE_METHOD_FAILED", message: String(error).slice(0, 2000) };
}

/**
 * 把字节流切成行。超长的行不等换行就报错——不能先把 100 MiB 攒进内存再判断。
 */
export class LineSplitter {
  private pending = "";
  private pendingBytes = 0;

  constructor(private readonly maxBytes = MAX_FRAME_BYTES) {}

  push(chunk: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      const piece = newline < 0 ? chunk.slice(start) : chunk.slice(start, newline);
      this.pendingBytes += Buffer.byteLength(piece, "utf8");
      if (this.pendingBytes > this.maxBytes)
        throw new HostProtocolError("FRAME_TOO_LARGE", "host-control 帧超过上限");
      this.pending += piece;
      if (newline < 0) break;
      const line = this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending;
      if (line.length > 0) lines.push(line);
      this.pending = "";
      this.pendingBytes = 0;
      start = newline + 1;
    }
    return lines;
  }
}
