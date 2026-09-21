import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("WAIT_FOR_TIMEOUT");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

async function openAuthenticatedWebSocket(
  url: string,
  token: string,
): Promise<{ socket: WebSocket; frames: any[] }> {
  const frames: any[] = [];
  const socket = new WebSocket(url);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error("WS_AUTH_TIMEOUT")), 2_000);
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ type: "authenticate", token })),
    );
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      frames.push(frame);
      if (frame.type === "authenticated") {
        clearTimeout(timeout);
        resolvePromise();
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      rejectPromise(new Error("WS_ERROR"));
    });
  });
  return { socket, frames };
}

async function waitForClose(socket: WebSocket): Promise<CloseEvent> {
  if (socket.readyState === WebSocket.CLOSED) {
    return { code: 1000, reason: "" } as CloseEvent;
  }
  return new Promise((resolvePromise) => {
    socket.addEventListener("close", (event) => resolvePromise(event), { once: true });
    socket.close();
  });
}

function deltaEvent(seq: number) {
  return {
    scope: "global",
    seq,
    type: "project.created",
    key: `project-${seq}`,
    summary: `project-${seq}`,
    at: new Date(1_000 + seq).toISOString(),
  };
}

async function websocketFrames(
  url: string,
  token: string,
  done: (frame: any, frames: any[]) => boolean,
): Promise<any[]> {
  return new Promise((resolvePromise, reject) => {
    const frames: any[] = [];
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`WS_TIMEOUT: ${JSON.stringify(frames)}`));
    }, 5000);
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ type: "authenticate", token })),
    );
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      frames.push(frame);
      if (done(frame, frames)) {
        clearTimeout(timeout);
        socket.close();
        resolvePromise(frames);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WS_ERROR"));
    });
    socket.addEventListener("close", (event) => {
      if (!frames.some((frame) => done(frame, frames))) {
        clearTimeout(timeout);
        reject(new Error(`WS_CLOSED: ${event.code} ${event.reason}`));
      }
    });
  });
}

async function websocketClose(
  url: string,
  token?: string,
): Promise<{ code: number; reason: string; frames: unknown[] }> {
  return new Promise((resolvePromise, reject) => {
    const frames: unknown[] = [];
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`WS_CLOSE_TIMEOUT: ${JSON.stringify(frames)}`));
    }, 5000);
    socket.addEventListener("open", () => {
      if (token !== undefined) socket.send(JSON.stringify({ type: "authenticate", token }));
    });
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)));
    });
    socket.addEventListener("error", () => {
      // Authentication rejection can emit an error before the close event in some runtimes.
    });
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      resolvePromise({ code: event.code, reason: event.reason, frames });
    });
  });
}

describe("WebSocket gap replay", () => {
  it("错误 token 与认证超时均 fail closed，认证前不发送业务帧", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-ws-auth-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    await service.createProject({ name: "WebSocket 认证", sourcePath: null, code: "WSA" });
    const app = await buildAyanamiServer({ service, token: "ws-current-secret" });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("ADDRESS_MISSING");
      const url = `ws://127.0.0.1:${address.port}/api/v1/ws?scope=project:WSA&since=0`;

      const rejected = await websocketClose(url, "ws-stale-secret");
      expect(rejected).toMatchObject({ code: 1008, reason: "Authentication failed", frames: [] });
      expect(JSON.stringify(rejected)).not.toContain("ws-current-secret");

      const timedOut = await websocketClose(url);
      expect(timedOut).toMatchObject({
        code: 1008,
        reason: "Authentication required",
        frames: [],
      });
      expect(JSON.stringify(timedOut)).not.toContain("ws-current-secret");
    } finally {
      await app.close();
      service.close();
    }
  }, 10_000);

  it("项目流和全局流按 since 补齐，无重复与跳号", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-ws-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "ws-secret" });
    try {
      await service.createProject({ name: "WebSocket 测试", sourcePath: null, code: "WSP" });
      const objective = await service.createObjectiveAsUser("WSP", "objective-1", {
        title: "断线重放",
        description: "",
        definitionOfDone: [],
      });
      const task = (
        await service.createWorkItemsAsUser("WSP", "task-1", [
          {
            clientRef: "ws",
            objectiveId: objective.id,
            title: "验证 gap replay",
            description: "",
            type: "TASK",
            priority: "NORMAL",
            status: "READY",
            acceptance: [],
            checklist: [],
            verificationRequired: false,
          },
        ])
      ).items[0]!;
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("ADDRESS_MISSING");
      const root = `ws://127.0.0.1:${address.port}/api/v1/ws`;

      const initial = await websocketFrames(
        `${root}?scope=project:WSP&since=0`,
        "ws-secret",
        (frame) => frame.type === "work.created",
      );
      const initialEvents = initial.filter((frame) => Number.isInteger(frame.seq));
      const sequences = initialEvents.map((frame) => frame.seq);
      expect(sequences).toEqual([...new Set(sequences)].sort((left, right) => left - right));
      const last = Math.max(...sequences);

      await service.patchWorkItemsAsUser("WSP", "start-1", [
        {
          taskKey: task.key,
          expectedVersion: task.version,
          operation: "start",
          takeoverStale: false,
        },
      ]);
      const resumed = await websocketFrames(
        `${root}?scope=project:WSP&since=${last}`,
        "ws-secret",
        (frame) => frame.type === "work.started",
      );
      const resumedEvents = resumed.filter((frame) => Number.isInteger(frame.seq));
      expect(resumedEvents.every((frame) => frame.seq > last)).toBe(true);
      expect(resumedEvents.filter((frame) => frame.type === "work.started")).toHaveLength(1);

      const global = await websocketFrames(
        `${root}?scope=global&since=0`,
        "ws-secret",
        (frame) => frame.type === "project.created",
      );
      expect(global).toContainEqual(
        expect.objectContaining({
          scope: "global",
          type: "project.created",
          seq: expect.any(Number),
        }),
      );
    } finally {
      await app.close();
      service.close();
    }
  });

  it("订阅先于 replay，replay 期间的通知不会丢失", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-ws-gap-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "ws-secret" });
    const firstReplay = deferred<void>();
    const events: ReturnType<typeof deltaEvent>[] = [];
    let deltaCalls = 0;
    let listener: (() => void) | null = null;
    const unsubscribe = vi.spyOn(service, "subscribeGlobal").mockImplementation((callback) => {
      listener = callback;
      return () => undefined;
    });
    vi.spyOn(service, "globalDelta").mockImplementation(((sinceSequence: number) => {
      deltaCalls += 1;
      const snapshot = events.filter((event) => event.seq > sinceSequence);
      if (deltaCalls === 1) {
        return firstReplay.promise.then(() => ({
          events: snapshot,
          hasMore: false,
          currentSequence: events.at(-1)?.seq ?? 0,
        }));
      }
      return {
        events: snapshot,
        hasMore: false,
        currentSequence: events.at(-1)?.seq ?? 0,
      };
    }) as any);
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("ADDRESS_MISSING");
      const { socket, frames } = await openAuthenticatedWebSocket(
        `ws://127.0.0.1:${address.port}/api/v1/ws?scope=global&since=0`,
        "ws-secret",
      );
      try {
        await waitFor(() => deltaCalls === 1 && listener !== null);
        events.push(deltaEvent(1));
        listener!();
        firstReplay.resolve();
        await waitFor(() => frames.some((frame) => frame.seq === 1));
        expect(frames.filter((frame) => frame.seq === 1)).toHaveLength(1);
      } finally {
        await waitForClose(socket);
      }
    } finally {
      unsubscribe.mockRestore();
      await app.close();
      service.close();
    }
  });

  it("同一连接的重叠通知 single-flight 且每个序号只发送一次", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-ws-flight-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "ws-secret" });
    const firstNotification = deferred<void>();
    const events: ReturnType<typeof deltaEvent>[] = [];
    let deltaCalls = 0;
    let listener: (() => void) | null = null;
    const unsubscribe = vi.spyOn(service, "subscribeGlobal").mockImplementation((callback) => {
      listener = callback;
      return () => undefined;
    });
    vi.spyOn(service, "globalDelta").mockImplementation(((sinceSequence: number) => {
      deltaCalls += 1;
      const snapshot = events.filter((event) => event.seq > sinceSequence);
      if (deltaCalls === 2) {
        return firstNotification.promise.then(() => ({
          events: snapshot,
          hasMore: false,
          currentSequence: events.at(-1)?.seq ?? 0,
        }));
      }
      return {
        events: snapshot,
        hasMore: false,
        currentSequence: events.at(-1)?.seq ?? 0,
      };
    }) as any);
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("ADDRESS_MISSING");
      const { socket, frames } = await openAuthenticatedWebSocket(
        `ws://127.0.0.1:${address.port}/api/v1/ws?scope=global&since=0`,
        "ws-secret",
      );
      try {
        await waitFor(() => deltaCalls === 1 && listener !== null);
        events.push(deltaEvent(1));
        listener!();
        await waitFor(() => deltaCalls === 2);
        events.push(deltaEvent(2));
        listener!();
        firstNotification.resolve();
        await waitFor(() => frames.filter((frame) => Number.isInteger(frame.seq)).length >= 2);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
        expect(
          frames.filter((frame) => Number.isInteger(frame.seq)).map((frame) => frame.seq),
        ).toEqual([1, 2]);
      } finally {
        await waitForClose(socket);
      }
    } finally {
      unsubscribe.mockRestore();
      await app.close();
      service.close();
    }
  });

  it("hasMore 但序号没有推进时终止当前流，避免无界 replay", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-ws-progress-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "ws-secret" });
    let deltaCalls = 0;
    const unsubscribe = vi.spyOn(service, "subscribeGlobal").mockReturnValue(() => undefined);
    vi.spyOn(service, "globalDelta").mockImplementation(() => {
      deltaCalls += 1;
      return { events: [deltaEvent(0)], hasMore: true, currentSequence: 0 };
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("ADDRESS_MISSING");
      const { socket, frames } = await openAuthenticatedWebSocket(
        `ws://127.0.0.1:${address.port}/api/v1/ws?scope=global&since=0`,
        "ws-secret",
      );
      const closePromise = new Promise<CloseEvent>((resolvePromise) =>
        socket.addEventListener("close", (event) => resolvePromise(event), { once: true }),
      );
      const close = await closePromise;
      expect(close.code).toBe(1011);
      expect(frames).toContainEqual({ type: "error", code: "STREAM_FAILED" });
      expect(deltaCalls).toBe(1);
    } finally {
      unsubscribe.mockRestore();
      await app.close();
      service.close();
    }
  });

  it("replay 期间关闭会幂等清理，之后不订阅也不发送", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-ws-close-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "ws-secret" });
    const firstReplay = deferred<void>();
    let deltaCalls = 0;
    let unsubscribeCalls = 0;
    const unsubscribe = vi.spyOn(service, "subscribeGlobal").mockImplementation(() => {
      return () => {
        unsubscribeCalls += 1;
      };
    });
    vi.spyOn(service, "globalDelta").mockImplementation(((sinceSequence: number) => {
      deltaCalls += 1;
      if (deltaCalls === 1) {
        return firstReplay.promise.then(() => ({
          events: [deltaEvent(1)],
          hasMore: false,
          currentSequence: 1,
        }));
      }
      return { events: [], hasMore: false, currentSequence: sinceSequence };
    }) as any);
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("ADDRESS_MISSING");
      const { socket, frames } = await openAuthenticatedWebSocket(
        `ws://127.0.0.1:${address.port}/api/v1/ws?scope=global&since=0`,
        "ws-secret",
      );
      await waitFor(() => deltaCalls === 1);
      await waitForClose(socket);
      firstReplay.resolve();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
      expect(unsubscribeCalls).toBe(1);
      expect(deltaCalls).toBe(1);
      expect(frames.filter((frame) => Number.isInteger(frame.seq))).toHaveLength(0);
    } finally {
      unsubscribe.mockRestore();
      await app.close();
      service.close();
    }
  });

  it("delta 拒绝只终止当前连接，不会杀掉宿主进程", async () => {
    const childScript = String.raw`
      import { mkdtempSync, rmSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join, resolve } from "node:path";
      const { AyanamiTaskService } = await import("@ayanami-task/application");
      const { buildAyanamiServer } = await import("./src/index.ts");
      const dataDir = mkdtempSync(join(tmpdir(), "atm-ws-child-"));
      const service = await AyanamiTaskService.open({
        dataDir,
        migrationsRoot: resolve(process.cwd(), "../../migrations"),
      });
      service.delta = async () => {
        throw new Error("delta refused");
      };
      const app = await buildAyanamiServer({ service, token: "child-secret" });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("ADDRESS_MISSING");
      console.log(JSON.stringify({ port: address.port }));
      setTimeout(async () => {
        await app.close();
        service.close();
        rmSync(dataDir, { recursive: true, force: true });
      }, 1_000).unref();
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childScript],
      { cwd: resolve(process.cwd(), "apps/daemon"), stdio: ["ignore", "pipe", "pipe"] },
    );
    let childStderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      childStderr += chunk.toString();
    });
    const port = await new Promise<number>((resolvePromise, rejectPromise) => {
      let output = "";
      const timeout = setTimeout(() => rejectPromise(new Error("CHILD_START_TIMEOUT")), 5_000);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const line = output.split(/\r?\n/).find((candidate) => candidate.trim().startsWith("{"));
        if (!line) return;
        clearTimeout(timeout);
        resolvePromise(Number((JSON.parse(line) as { port: number }).port));
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      });
      child.once("exit", (code, signal) => {
        if (code === null || code !== 0) {
          clearTimeout(timeout);
          rejectPromise(new Error(`CHILD_EXITED_EARLY: ${code ?? signal}: ${childStderr}`));
        }
      });
    });
    try {
      const observed = await new Promise<{ frames: any[]; code: number }>(
        (resolvePromise, rejectPromise) => {
          const frames: any[] = [];
          const socket = new WebSocket(
            `ws://127.0.0.1:${port}/api/v1/ws?scope=project:CHILD&since=0`,
          );
          const timeout = setTimeout(() => {
            socket.close();
            rejectPromise(new Error(`CHILD_WS_TIMEOUT: ${JSON.stringify(frames)}`));
          }, 5_000);
          socket.addEventListener("open", () =>
            socket.send(JSON.stringify({ type: "authenticate", token: "child-secret" })),
          );
          socket.addEventListener("message", (event) =>
            frames.push(JSON.parse(String(event.data))),
          );
          socket.addEventListener("error", () => undefined);
          socket.addEventListener("close", (event) => {
            clearTimeout(timeout);
            resolvePromise({ frames, code: event.code });
          });
        },
      );
      expect(observed.frames).toContainEqual({ type: "authenticated" });
      expect(observed.frames).toContainEqual({ type: "error", code: "STREAM_FAILED" });
      expect(observed.code).toBe(1011);
    } finally {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolvePromise, rejectPromise) => {
          const timeout = setTimeout(() => rejectPromise(new Error("CHILD_EXIT_TIMEOUT")), 5_000);
          child.once("exit", (code, signal) => {
            clearTimeout(timeout);
            resolvePromise({ code, signal });
          });
        },
      );
      expect(exit).toEqual({ code: 0, signal: null });
    }
  }, 12_000);

  it.each(["1.5", "-1", "9007199254740992", "not-a-number"])(
    "拒绝不安全的 since=%s 查询参数",
    async (since) => {
      const dataDir = mkdtempSync(join(tmpdir(), "atm-ws-query-"));
      temporary.push(dataDir);
      const service = await AyanamiTaskService.open({
        dataDir,
        migrationsRoot: resolve(process.cwd(), "migrations"),
      });
      const app = await buildAyanamiServer({ service, token: "ws-secret" });
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("ADDRESS_MISSING");
        const rejected = await websocketClose(
          `ws://127.0.0.1:${address.port}/api/v1/ws?scope=global&since=${since}`,
          "ws-secret",
        );
        expect(rejected).toMatchObject({ code: 1008, reason: "Invalid query", frames: [] });
      } finally {
        await app.close();
        service.close();
      }
    },
  );

  it.each(["", "project:", "workspace:WSP"])("拒绝不支持的 scope=%s 查询参数", async (scope) => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-ws-scope-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "ws-secret" });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("ADDRESS_MISSING");
      const rejected = await websocketClose(
        `ws://127.0.0.1:${address.port}/api/v1/ws?scope=${encodeURIComponent(scope)}&since=0`,
        "ws-secret",
      );
      expect(rejected).toMatchObject({ code: 1008, reason: "Invalid query", frames: [] });
    } finally {
      await app.close();
      service.close();
    }
  });
});
