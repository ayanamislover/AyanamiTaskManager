import {
  ChangeFeed,
  CommandDocSchema,
  RelayClient,
  RelayError,
  SpaceStore,
  commandKey,
  deriveSpaceKeys,
  type AckDoc,
  type CommandDoc,
  type DeviceDoc,
  type FetchLike,
  type HeadDoc,
  type PairingPayload,
  type ProjectDoc,
  type RevokedDoc,
} from "@ayanami-task/sync-protocol";
import type { ChangeBatch, SyncBackend } from "./backend.js";

/** 手机前台轮询间隔（中继不支持长轮询时）。 */
export const FOREGROUND_POLL_MS = 3_000;

/**
 * 真实中继：RelayClient 负责 HTTP，SpaceStore 负责加密与分片，ChangeFeed 负责变更流。
 * HTTP 走传进来的 fetchImpl（手机上是 CapacitorHttp 适配器），不碰全局 fetch。
 */
export class RelayBackend implements SyncBackend {
  readonly spaceId: string;
  readonly #client: RelayClient;
  readonly #store: SpaceStore;
  #feed: ChangeFeed | null = null;
  #probe: { longPoll: boolean; maxWait: number } | null = null;

  private constructor(pairing: PairingPayload, client: RelayClient, store: SpaceStore) {
    this.spaceId = pairing.s;
    this.#client = client;
    this.#store = store;
  }

  static async create(pairing: PairingPayload, fetchImpl: FetchLike): Promise<RelayBackend> {
    const client = new RelayClient({
      baseUrl: pairing.u,
      appId: pairing.a,
      token: pairing.t,
      fetchImpl,
    });
    const keys = await deriveSpaceKeys(pairing.k);
    const store = new SpaceStore({ client, keys, spaceId: pairing.s });
    return new RelayBackend(pairing, client, store);
  }

  async connect(cursor: string | null): Promise<{ longPoll: boolean }> {
    const probe = await this.#client.probe();
    this.#probe = { longPoll: probe.longPoll, maxWait: probe.maxWait || 25 };
    this.#feed = this.#newFeed(this.#feed?.cursor ?? cursor);
    return { longPoll: probe.longPoll };
  }

  #newFeed(cursor: string | null): ChangeFeed {
    const probe = this.#probe ?? { longPoll: false, maxWait: 25 };
    return new ChangeFeed({
      client: this.#client,
      spaceId: this.spaceId,
      cursor,
      longPoll: probe.longPoll,
      maxWait: probe.maxWait,
      intervalMs: FOREGROUND_POLL_MS,
    });
  }

  readHead(): Promise<HeadDoc | null> {
    return this.#store.readHead();
  }

  readRevoked(): Promise<RevokedDoc | null> {
    return this.#store.readRevoked();
  }

  readProject(hash: string): Promise<ProjectDoc | null> {
    return this.#store.readProject(hash);
  }

  readDevice(id: string): Promise<DeviceDoc | null> {
    return this.#store.readDevice(id);
  }

  /**
   * 不用 SpaceStore.sendCommand：它在发送那一刻才生成命令 ID。手机要先把 ID 落盘再发，
   * 这样「写到中继了但没来得及记下」的那条重启后用同一个 ID 重发，电脑端按 ID 幂等，
   * 不会建出两个任务。
   */
  async writeCommand(doc: CommandDoc): Promise<void> {
    const checked = CommandDocSchema.parse(doc);
    await this.#store.writeObject(commandKey(this.spaceId, checked.id), checked, { fresh: true });
  }

  readAck(id: string): Promise<AckDoc | null> {
    return this.#store.readAck(id);
  }

  deleteAck(id: string): Promise<void> {
    return this.#store.deleteAck(id);
  }

  writeDevice(doc: DeviceDoc): Promise<void> {
    return this.#store.writeDevice(doc);
  }

  /**
   * atm-relay 与 AyanamiCloud 的游标互不通用，拿对方的游标会回 400（例如中继换了实现、地址没变）。
   * 400 时按游标失效处理一次：从空游标重建变更流（返回 reset，引擎随即全量重读）；再失败才报错。
   */
  async nextChanges(signal: AbortSignal): Promise<ChangeBatch> {
    if (!this.#feed) throw new Error("RelayBackend.connect() 之前不能读变更流");
    try {
      return await this.#feed.next(signal);
    } catch (error) {
      if (!(error instanceof RelayError) || error.status !== 400 || this.#feed.cursor === null)
        throw error;
      this.#feed = this.#newFeed(null);
      return this.#feed.next(signal);
    }
  }

  poke(): void {
    this.#feed?.poke();
  }
}
