import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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

describe("WebSocket gap replay", () => {
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
});
