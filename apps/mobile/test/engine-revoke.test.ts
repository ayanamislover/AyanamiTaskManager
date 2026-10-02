import { describe, expect, it } from "vitest";
import { headKey, revokedKey } from "@ayanami-task/sync-protocol";
import {
  ScriptedBackend,
  change,
  revokedDoc,
  settle,
  started,
} from "./support/scripted-backend.js";

describe("电脑重置配对后旧手机的反应", () => {
  it("变更流里头部被删：停在 rekey，不会被随后的「已同步」盖回 live", async () => {
    const backend = new ScriptedBackend();
    const engine = await started(backend);
    await settle(engine, (phase) => phase === "live");
    backend.head = null;
    backend.batches.push([change(headKey(backend.spaceId), "delete", 1)]);
    engine.refresh();
    await settle(engine, (phase) => phase === "rekey");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(engine.getState().phase).toBe("rekey");
    expect(engine.getState().lastError).toContain("重新扫码");
    await engine.stop();
  });

  it("变更流里出现撤销标记：rekey，并说出是哪台电脑重置的", async () => {
    const backend = new ScriptedBackend();
    const engine = await started(backend);
    await settle(engine, (phase) => phase === "live");
    backend.revoked = revokedDoc();
    backend.batches.push([change(revokedKey(backend.spaceId), "put", 1)]);
    engine.refresh();
    await settle(engine, (phase) => phase === "rekey");
    expect(engine.getState().lastError).toBe("电脑「工作站」已经重置了配对，这台手机需要重新扫码");
    await engine.stop();
  });

  it("离线期间被重置、回来后全量重读：没有头部但有撤销标记 → rekey，不再写心跳", async () => {
    const backend = new ScriptedBackend();
    backend.head = null;
    backend.revoked = revokedDoc();
    const engine = await started(backend);
    await settle(engine, (phase) => phase === "rekey");
    const writes = backend.deviceWrites;
    engine.refresh();
    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(engine.getState().phase).toBe("rekey");
    expect(backend.deviceWrites).toBe(writes);
    await engine.stop();
  });

  it("清理只成功了一部分（旧头部还在）又有撤销标记：全量重读照样判作废", async () => {
    const backend = new ScriptedBackend();
    backend.revoked = revokedDoc();
    const engine = await started(backend);
    await settle(engine, (phase) => phase === "rekey");
    expect(engine.getState().lastError).toContain("重新扫码");
    expect(backend.written).toEqual([]);
    await engine.stop();
  });

  it("没有头部也没有撤销标记：只是电脑还没发布，照常在线等待", async () => {
    const backend = new ScriptedBackend();
    backend.head = null;
    const engine = await started(backend);
    await settle(engine, (phase) => phase === "live");
    expect(engine.getState().snapshot.head).toBeNull();
    await engine.stop();
  });
});
