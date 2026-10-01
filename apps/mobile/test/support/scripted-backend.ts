import {
  generateSpace,
  newDeviceId,
  type AckDoc,
  type CommandDoc,
  type HeadDoc,
  type RelayChange,
  type RevokedDoc,
} from "@ayanami-task/sync-protocol";
import type { ChangeBatch, SyncBackend } from "../../src/data/backend.js";
import { SyncEngine, type Pairing } from "../../src/data/engine.js";

export const HOST = { id: newDeviceId("pc"), name: "工作站" };

export function head(): HeadDoc {
  return {
    v: 1,
    host: { ...HOST, app: "atm/2.0.0" },
    at: new Date().toISOString(),
    dispatch: { enabled: true, mode: "auto", running: 0 },
    projects: [],
  };
}

export function change(key: string, op: RelayChange["op"], seq: number): RelayChange {
  return { seq, key, revision: seq, op, deviceId: null, at: new Date().toISOString() };
}

export const revokedDoc = (): RevokedDoc => ({
  v: 1,
  at: new Date().toISOString(),
  host: HOST,
});

/**
 * 内存里的假中继：头部、撤销标记、回执由用例直接改；变更流按脚本逐批给出，脚本放完就一直等到被打断。
 * 引擎只认 SyncBackend 这个接口，所以这里不需要加密。
 * `abortLagMs` 模拟真实网络：被打断后过一会儿才失败返回，旧循环因此会晚一点才醒。
 */
export class ScriptedBackend implements SyncBackend {
  readonly spaceId = generateSpace().spaceId;
  head: HeadDoc | null = head();
  revoked: RevokedDoc | null = null;
  readonly batches: RelayChange[][] = [];
  readonly acks = new Map<string, AckDoc>();
  readonly written: CommandDoc[] = [];
  readonly deletedAcks: string[] = [];
  deviceWrites = 0;
  /** readHead / readRevoked 的调用次数：停止后的实例不该再联网读任何东西。 */
  reads = 0;
  abortLagMs = 0;
  polling = 0;
  maxPolling = 0;

  async connect() {
    return { longPoll: true };
  }
  async readHead() {
    this.reads += 1;
    return this.head;
  }
  async readRevoked() {
    this.reads += 1;
    return this.revoked;
  }
  async readProject() {
    return null;
  }
  async readDevice() {
    return null;
  }
  async writeCommand(doc: CommandDoc) {
    this.written.push(doc);
  }
  async readAck(id: string) {
    return this.acks.get(id) ?? null;
  }
  async deleteAck(id: string) {
    this.deletedAcks.push(id);
    this.acks.delete(id);
  }
  async writeDevice() {
    this.deviceWrites += 1;
  }
  async nextChanges(signal: AbortSignal): Promise<ChangeBatch> {
    const changes = this.batches.shift();
    if (changes) return { changes, cursor: `c${changes.length}`, reset: false };
    this.polling += 1;
    this.maxPolling = Math.max(this.maxPolling, this.polling);
    try {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (this.abortLagMs > 0) await new Promise((resolve) => setTimeout(resolve, this.abortLagMs));
    } finally {
      this.polling -= 1;
    }
    throw new DOMException("aborted", "AbortError");
  }
  poke() {}
}

export function pairingFor(backend: ScriptedBackend): Pairing {
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

export async function settle(engine: SyncEngine, done: (phase: string) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (done(engine.getState().phase)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`引擎一直停在 ${engine.getState().phase}`);
}

export async function waitUntil(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等不到：${label}`);
}

export async function started(backend: ScriptedBackend): Promise<SyncEngine> {
  const engine = new SyncEngine({ backend, pairing: pairingFor(backend), appVersion: "1.0.0" });
  await engine.load();
  engine.start();
  return engine;
}
