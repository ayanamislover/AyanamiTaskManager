import { describe, expect, it } from "vitest";
import {
  generateSpace,
  headKey,
  newDeviceId,
  revokedKey,
  type HeadDoc,
  type RelayChange,
  type RevokedDoc,
} from "@ayanami-task/sync-protocol";
import type { ChangeBatch, SyncBackend } from "../src/data/backend.js";
import { SyncEngine, type Pairing } from "../src/data/engine.js";

const HOST = { id: newDeviceId("pc"), name: "工作站" };

function head(): HeadDoc {
  return {
    v: 1,
    host: { ...HOST, app: "atm/2.0.0" },
    at: new Date().toISOString(),
    dispatch: { enabled: true, mode: "auto", running: 0 },
    projects: [],
  };
}

function change(key: string, op: RelayChange["op"], seq: number): RelayChange {
  return { seq, key, revision: seq, op, deviceId: null, at: new Date().toISOString() };
}

/**
 * 内存里的假中继：头部与撤销标记由用例直接改；变更流按脚本逐批给出，脚本放完就一直等到被打断。
 * 引擎只认 SyncBackend 这个接口，所以这里不需要加密。
 */
class ScriptedBackend implements SyncBackend {
  readonly spaceId = generateSpace().spaceId;
  head: HeadDoc | null = head();
  revoked: RevokedDoc | null = null;
  readonly batches: RelayChange[][] = [];
  deviceWrites = 0;

  async connect() {
    return { longPoll: true };
  }
  async readHead() {
    return this.head;
  }
  async readRevoked() {
    return this.revoked;
  }
  async readProject() {
    return null;
  }
  async readDevice() {
    return null;
  }
  async writeCommand() {}
  async readAck() {
    return null;
  }
  async deleteAck() {}
  async writeDevice() {
    this.deviceWrites += 1;
  }
  async nextChanges(signal: AbortSignal): Promise<ChangeBatch> {
    const changes = this.batches.shift();
    if (changes) return { changes, cursor: `c${changes.length}`, reset: false };
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    throw new Error("aborted");
  }
  poke() {}
}

function pairingFor(backend: ScriptedBackend): Pairing {
  return {
    v: 1,
    u: "https://relay.test",
    a: "atm",
    t: "atr_test_token",
    s: backend.spaceId,
    k: generateSpace().secret,
    n: HOST.name,
    deviceId: newDeviceId("m"),
    deviceName: "测试手机",
    pairedAt: new Date().toISOString(),
  };
}

async function settle(engine: SyncEngine, done: (phase: string) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (done(engine.getState().phase)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`引擎一直停在 ${engine.getState().phase}`);
}

async function started(backend: ScriptedBackend): Promise<SyncEngine> {
  const engine = new SyncEngine({ backend, pairing: pairingFor(backend), appVersion: "1.0.0" });
  await engine.load();
  engine.start();
  return engine;
}

const revokedDoc = (): RevokedDoc => ({ v: 1, at: new Date().toISOString(), host: HOST });

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

  it("没有头部也没有撤销标记：只是电脑还没发布，照常在线等待", async () => {
    const backend = new ScriptedBackend();
    backend.head = null;
    const engine = await started(backend);
    await settle(engine, (phase) => phase === "live");
    expect(engine.getState().snapshot.head).toBeNull();
    await engine.stop();
  });
});
