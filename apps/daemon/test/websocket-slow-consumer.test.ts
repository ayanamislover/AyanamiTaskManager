import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "../src/index.js";

async function waitFor(predicate: () => boolean, timeout: number): Promise<void> {
  const until = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= until) throw new Error("SLOW_CONSUMER_WAIT_TIMEOUT");
    await new Promise((done) => setTimeout(done, 10));
  }
}

function maskedAuthentication(token: string): Buffer {
  const payload = Buffer.from(JSON.stringify({ type: "authenticate", token }));
  if (payload.length >= 126) throw new Error("TEST_AUTH_FRAME_TOO_LARGE");
  const mask = randomBytes(4);
  return Buffer.concat([
    Buffer.from([0x81, 0x80 | payload.length]),
    mask,
    Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!)),
  ]);
}

/** Drain frames without retaining the large event bodies; record the actual wire close code. */
function closeFrameReader() {
  let pending = Buffer.alloc(0);
  let closeCode: number | undefined;
  return {
    get code() {
      return closeCode;
    },
    read(chunk: Buffer) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const opcode = pending[0]! & 0x0f;
        const size = pending[1]! & 0x7f;
        const header = size === 127 ? 10 : size === 126 ? 4 : 2;
        if (pending.length < header) return;
        const length =
          size === 127
            ? Number(pending.readBigUInt64BE(2))
            : size === 126
              ? pending.readUInt16BE(2)
              : size;
        if (length > 512 * 1024) throw new Error("TEST_FRAME_BOUND_EXCEEDED");
        if (pending.length < header + length) return;
        if (opcode === 8 && length >= 2) closeCode = pending.readUInt16BE(header);
        pending = pending.subarray(header + length);
      }
    },
  };
}

it("真实慢TCP客户端5秒发送超时后1011收口，停止泵并允许从已处理since重连", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atm-ws-slow-"));
  const service = await AyanamiTaskService.open({
    dataDir: directory,
    migrationsRoot: resolve("migrations"),
  });
  const app = await buildAyanamiServer({ service, token: "slow-secret" });
  let raw: Socket | undefined;
  let resumed: WebSocket | undefined;
  let released = 0;
  let pressure = true;
  let subscribedAt = 0;
  let releasedAt = 0;
  const summary = "x".repeat(256 * 1024);
  const subscribe = vi.spyOn(service, "subscribeGlobal").mockImplementation(() => {
    subscribedAt = performance.now();
    return () => {
      released++;
      releasedAt = performance.now();
    };
  });
  const delta = vi.spyOn(service, "globalDelta").mockImplementation((since) => {
    // Bounded synthetic event supply: transport and its OS backpressure remain real.
    if (since >= 263) throw new Error("TEST_EVENT_CAP_WITHOUT_BACKPRESSURE");
    return {
      events: [
        {
          scope: "global",
          seq: since + 1,
          type: "project.updated",
          key: `event-${since + 1}`,
          summary: pressure ? summary : "resumed",
          at: "2026-09-21T00:00:00.000Z",
        },
      ],
      hasMore: pressure,
      currentSequence: 263,
    };
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("ADDRESS_MISSING");
    const reader = closeFrameReader();
    raw = createConnection({ host: "127.0.0.1", port: address.port });
    const socket = raw;
    const errors: Error[] = [];
    socket.on("error", (error) => errors.push(error));
    await new Promise<void>((done, reject) => {
      const deadline = setTimeout(() => reject(new Error("TEST_UPGRADE_TIMEOUT")), 3000);
      let headers = Buffer.alloc(0);
      const receive = (chunk: Buffer) => {
        headers = Buffer.concat([headers, chunk]);
        const end = headers.indexOf("\r\n\r\n");
        if (end < 0) return;
        clearTimeout(deadline);
        socket.off("data", receive);
        if (!headers.toString("ascii", 0, end).startsWith("HTTP/1.1 101 ")) {
          reject(new Error("TEST_UPGRADE_REJECTED"));
          return;
        }
        socket.pause();
        reader.read(headers.subarray(end + 4));
        socket.on("data", reader.read);
        socket.write(maskedAuthentication("slow-secret"));
        done();
      };
      socket.on("data", receive);
      socket.on("connect", () =>
        socket.write(
          [
            "GET /api/v1/ws?scope=global&since=7 HTTP/1.1",
            `Host: 127.0.0.1:${address.port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Version: 13",
            `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
            "",
            "",
          ].join("\r\n"),
        ),
      );
    });
    await waitFor(() => released > 0, 9000);
    expect(released).toBe(1);
    expect(releasedAt - subscribedAt).toBeGreaterThanOrEqual(4900);
    expect(releasedAt - subscribedAt).toBeLessThan(9000);
    const callsAtRelease = delta.mock.calls.length;
    expect(callsAtRelease).toBeGreaterThan(1);
    expect(callsAtRelease).toBeLessThan(256);
    expect(delta.mock.calls[0]?.[0]).toBe(7);
    await new Promise((done) => setTimeout(done, 1000));
    expect(delta).toHaveBeenCalledTimes(callsAtRelease);
    expect(released).toBe(1);
    // Only now drain the OS buffers; no fake timer, mocked send or private socket fields.
    socket.resume();
    await waitFor(() => reader.code !== undefined, 3000);
    expect(reader.code).toBe(1011);
    expect(errors).toEqual([]);
    socket.destroy();

    pressure = false;
    resumed = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/ws?scope=global&since=7`);
    const client = resumed;
    const sequences: number[] = [];
    client.addEventListener("open", () =>
      client.send(JSON.stringify({ type: "authenticate", token: "slow-secret" })),
    );
    client.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      if (typeof frame.seq === "number") sequences.push(frame.seq);
    });
    await waitFor(() => sequences.length > 0, 3000);
    expect(sequences).toEqual([8]);
    expect(delta.mock.calls.at(-1)?.[0]).toBe(7);
    const closed = new Promise<void>((done) =>
      client.addEventListener("close", () => done(), { once: true }),
    );
    client.close();
    await closed;
    await waitFor(() => released === 2, 1000);
    expect(subscribe).toHaveBeenCalledTimes(2);
  } finally {
    raw?.destroy();
    resumed?.close();
    await app.close();
    vi.restoreAllMocks();
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
