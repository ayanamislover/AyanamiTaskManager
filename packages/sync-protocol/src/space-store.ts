import type { ZodType } from "zod";

import { projectHash, type SpaceKeys } from "./crypto.js";
import { openObject, parseHeadEnvelope, sealObject } from "./envelope.js";
import { SyncProtocolError } from "./errors.js";
import {
  ackKey,
  commandKey,
  deviceKey,
  headKey,
  newCommandId,
  partKey,
  projectKey,
  spacePrefix,
} from "./keys.js";
import { RelayError, type RelayClient } from "./relay-client.js";
import {
  AckDocSchema,
  CommandDocSchema,
  DeviceDocSchema,
  HeadDocSchema,
  ProjectDocSchema,
  type AckDoc,
  type CommandDoc,
  type CommandInput,
  type DeviceDoc,
  type HeadDoc,
  type ProjectDoc,
} from "./schemas.js";

export type SpaceStoreOptions = {
  client: RelayClient;
  keys: SpaceKeys;
  spaceId: string;
  /** 读到正在更新的分片对象时的重试间隔，测试可调小。 */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const READ_ATTEMPTS = 4;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 一个配对空间的加密对象存储。负责分片、修订号与写入顺序；不做业务判断。
 * 修订号缓存只是优化：猜错时中继回 409 并带当前版本，这里用它重试一次。
 */
export class SpaceStore {
  readonly client: RelayClient;
  readonly keys: SpaceKeys;
  readonly spaceId: string;
  readonly #revisions = new Map<string, number>();
  readonly #partCounts = new Map<string, number>();
  readonly #retryDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: SpaceStoreOptions) {
    this.client = options.client;
    this.keys = options.keys;
    this.spaceId = options.spaceId;
    this.#retryDelayMs = options.retryDelayMs ?? 400;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  get prefix(): string {
    return spacePrefix(this.spaceId);
  }

  projectHash(code: string): Promise<string> {
    return projectHash(this.keys, code);
  }

  /** 让缓存忘掉某个键（例如变更流里看到别的设备删除了它）。 */
  forget(key: string): void {
    this.#revisions.delete(key);
  }

  async #put(key: string, data: unknown): Promise<number> {
    const expected = this.#revisions.get(key) ?? 0;
    try {
      const doc = await this.client.putDocument(key, expected, data);
      this.#revisions.set(key, doc.revision);
      return doc.revision;
    } catch (error) {
      if (!(error instanceof RelayError) || error.status !== 409) throw error;
      // 删除后重建要用 0；current 缺失即说明当前不存在。
      const retry = error.current?.revision ?? 0;
      const doc = await this.client.putDocument(key, retry, data);
      this.#revisions.set(key, doc.revision);
      return doc.revision;
    }
  }

  async #delete(key: string): Promise<boolean> {
    let expected = this.#revisions.get(key);
    if (expected === undefined) {
      const current = await this.client.getDocument(key);
      if (!current) return false;
      expected = current.revision;
    }
    try {
      const deleted = await this.client.deleteDocument(key, expected);
      this.#revisions.delete(key);
      return deleted;
    } catch (error) {
      if (!(error instanceof RelayError) || error.status !== 409) throw error;
      const current = await this.client.getDocument(key);
      if (!current) {
        this.#revisions.delete(key);
        return false;
      }
      const deleted = await this.client.deleteDocument(key, current.revision);
      this.#revisions.delete(key);
      return deleted;
    }
  }

  async #existingPartCount(logicalKey: string): Promise<number> {
    const cached = this.#partCounts.get(logicalKey);
    if (cached !== undefined) return cached;
    const listed = await this.client.listDocuments(`${logicalKey}.`);
    let highest = 0;
    for (const meta of listed) {
      const index = Number(meta.key.slice(logicalKey.length + 1));
      if (Number.isInteger(index) && index > highest) highest = index;
      this.#revisions.set(meta.key, meta.revision);
    }
    return highest + 1;
  }

  /**
   * 加密写入一个对象：先写 1..n-1 片，最后写第 0 片（提交点），再删掉旧版本多出来的片。
   * `fresh` 表示键是新生成的（命令、回执），省掉一次列举旧分片的请求。
   */
  async writeObject(
    logicalKey: string,
    value: unknown,
    options: { fresh?: boolean } = {},
  ): Promise<{ parts: number }> {
    const parts = await sealObject(this.keys, logicalKey, value);
    const previous = options.fresh ? 1 : await this.#existingPartCount(logicalKey);
    const [head, ...rest] = parts;
    for (const part of rest) await this.#put(part.key, part.data);
    if (head) await this.#put(head.key, head.data);
    for (let index = parts.length; index < previous; index += 1) {
      await this.#delete(partKey(logicalKey, index));
    }
    this.#partCounts.set(logicalKey, parts.length);
    return { parts: parts.length };
  }

  /** 读取并解密；不存在返回 null。写入进行中会稍等重读，超过次数抛 OBJECT_INCOMPLETE。 */
  async readObject<T>(logicalKey: string, schema: ZodType<T>): Promise<T | null> {
    for (let attempt = 1; ; attempt += 1) {
      const doc = await this.client.getDocument(logicalKey);
      if (!doc) {
        this.#revisions.delete(logicalKey);
        return null;
      }
      this.#revisions.set(logicalKey, doc.revision);
      try {
        const envelope = parseHeadEnvelope(doc.data);
        const plain = await openObject(this.keys, logicalKey, envelope, async (key) => {
          const part = await this.client.getDocument(key);
          if (part) this.#revisions.set(key, part.revision);
          return part?.data ?? null;
        });
        this.#partCounts.set(logicalKey, envelope.n);
        const parsed = schema.safeParse(plain);
        if (!parsed.success) throw new SyncProtocolError("SCHEMA_INVALID", logicalKey);
        return parsed.data;
      } catch (error) {
        const retryable = error instanceof SyncProtocolError && error.code === "OBJECT_INCOMPLETE";
        if (!retryable || attempt >= READ_ATTEMPTS) throw error;
        await this.#sleep(this.#retryDelayMs * attempt);
      }
    }
  }

  async deleteObject(logicalKey: string): Promise<void> {
    const count = Math.max(1, await this.#existingPartCount(logicalKey));
    await this.#delete(logicalKey);
    for (let index = 1; index < count; index += 1) await this.#delete(partKey(logicalKey, index));
    this.#partCounts.delete(logicalKey);
  }

  /** 列出本空间里某一类文档的逻辑键（跳过分片）。 */
  async listKeys(group: "p" | "cmd" | "ack" | "dev"): Promise<string[]> {
    const prefix = `${this.prefix}${group}/`;
    const listed = await this.client.listDocuments(prefix);
    const keys: string[] = [];
    for (const meta of listed) {
      this.#revisions.set(meta.key, meta.revision);
      if (!/\.\d{1,3}$/.test(meta.key)) keys.push(meta.key);
    }
    return keys;
  }

  // ─── 具体文档 ───

  readHead(): Promise<HeadDoc | null> {
    return this.readObject(headKey(this.spaceId), HeadDocSchema);
  }

  async writeHead(doc: HeadDoc): Promise<void> {
    await this.writeObject(headKey(this.spaceId), HeadDocSchema.parse(doc));
  }

  readProject(hash: string): Promise<ProjectDoc | null> {
    return this.readObject(projectKey(this.spaceId, hash), ProjectDocSchema);
  }

  async writeProject(hash: string, doc: ProjectDoc): Promise<void> {
    await this.writeObject(projectKey(this.spaceId, hash), ProjectDocSchema.parse(doc));
  }

  async deleteProject(hash: string): Promise<void> {
    await this.deleteObject(projectKey(this.spaceId, hash));
  }

  /** 手机发命令：生成命令 ID 并以「新建」写入（ID 唯一，不会覆盖别人的命令）。 */
  async sendCommand(
    device: { id: string; name: string },
    input: CommandInput,
    now: Date = new Date(),
  ): Promise<CommandDoc> {
    const id = newCommandId(device.id, now.getTime());
    const doc = CommandDocSchema.parse({ v: 1, id, device, at: now.toISOString(), ...input });
    await this.writeObject(commandKey(this.spaceId, id), doc, { fresh: true });
    return doc;
  }

  readCommand(commandId: string): Promise<CommandDoc | null> {
    return this.readObject(commandKey(this.spaceId, commandId), CommandDocSchema);
  }

  async deleteCommand(commandId: string): Promise<void> {
    await this.deleteObject(commandKey(this.spaceId, commandId));
  }

  async writeAck(doc: AckDoc): Promise<void> {
    await this.writeObject(ackKey(this.spaceId, doc.id), AckDocSchema.parse(doc), { fresh: true });
  }

  readAck(commandId: string): Promise<AckDoc | null> {
    return this.readObject(ackKey(this.spaceId, commandId), AckDocSchema);
  }

  async deleteAck(commandId: string): Promise<void> {
    await this.deleteObject(ackKey(this.spaceId, commandId));
  }

  async writeDevice(doc: DeviceDoc): Promise<void> {
    await this.writeObject(deviceKey(this.spaceId, doc.id), DeviceDocSchema.parse(doc));
  }

  readDevice(deviceId: string): Promise<DeviceDoc | null> {
    return this.readObject(deviceKey(this.spaceId, deviceId), DeviceDocSchema);
  }

  async deleteDevice(deviceId: string): Promise<void> {
    await this.deleteObject(deviceKey(this.spaceId, deviceId));
  }
}
