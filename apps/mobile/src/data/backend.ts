import type {
  AckDoc,
  CommandDoc,
  DeviceDoc,
  HeadDoc,
  ProjectDoc,
  RelayChange,
} from "@ayanami-task/sync-protocol";

export type ChangeBatch = { changes: RelayChange[]; cursor: string | null; reset: boolean };

/**
 * 同步引擎看到的中继：真实实现走 sync-protocol（加密、分片、修订号），
 * 演示实现在内存里模拟一台电脑。引擎只依赖这个接口，所以两者可以互换。
 */
export interface SyncBackend {
  readonly spaceId: string;
  /** 探测中继并从给定游标开始变更流；每次重新连上都会再调一次。 */
  connect(cursor: string | null): Promise<{ longPoll: boolean }>;
  readHead(): Promise<HeadDoc | null>;
  readProject(hash: string): Promise<ProjectDoc | null>;
  readDevice(id: string): Promise<DeviceDoc | null>;
  /** 以「新建」写入命令；同一个 ID 重复写入是幂等的。 */
  writeCommand(doc: CommandDoc): Promise<void>;
  readAck(id: string): Promise<AckDoc | null>;
  deleteAck(id: string): Promise<void>;
  writeDevice(doc: DeviceDoc): Promise<void>;
  /** 变更流的下一批。`reset` 为真时调用方要全量重读。 */
  nextChanges(signal: AbortSignal): Promise<ChangeBatch>;
  /** 让下一次 nextChanges 不等待（刚发了命令，想尽快看到回执）。 */
  poke(): void;
}
