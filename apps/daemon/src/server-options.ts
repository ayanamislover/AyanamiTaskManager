import type { AyanamiTaskService } from "@ayanami-task/application";

export type AyanamiServerOptions = {
  service: AyanamiTaskService;
  /** Agent 凭证：写进 runtime/daemon.json，MCP bridge、CLI 与按指南直调 REST 的 Agent 都用它。 */
  token: string;
  /**
   * 用户凭证（ATM-T-0503）。只由桌面主进程在内存里生成、经 renderer IPC 注入，从不落盘。
   * 配置后，标了 USER_ONLY 的路由只认它；不配置时退回单 token 模式（独立 daemon、单元测试），
   * 此时唯一的 token 同时代表用户。
   */
  userToken?: string;
  /**
   * 本次启动的时间（ISO 8601）。项目进度条的「已完成」只算这之后完成的任务。
   * 不传时取构建服务器的那一刻：桌面端在启动时进程内构建，正好就是「本次 ATM 启动」。
   */
  startedAt?: string;
  /** Claude 自动派单（可选）。不传时派单路由统一返回 404 DISPATCH_UNAVAILABLE。 */
  dispatch?: DispatchController;
  /** 手机同步连接器（可选）。不传时同步路由统一返回 404 SYNC_UNAVAILABLE。 */
  sync?: SyncController;
};

/**
 * 手机同步连接器的最小接口（docs/mobile-sync.md §7），路由在 sync-routes.ts。
 * `@ayanami-task/sync` 的 SyncConnector 满足它；daemon 不依赖那个包，由宿主注入。
 */
export type SyncController = {
  /** 状态，**不含任何密钥**（token、空间密钥、配对码都不在里面）。 */
  status(): Promise<unknown>;
  /** `{enabled?, relayUrl?, appId?, token?, deviceName?}`；token 只写不读。不合法抛 AtmError。 */
  updateConfig(patch: unknown): Promise<unknown>;
  /** 探测中继：`{ok, latencyMs, longPoll, server?, error?}`，连不上不抛错。 */
  testRelay(candidate?: unknown): Promise<unknown>;
  /** `{pairingCode, spaceId}`；配对码含 token 与空间密钥，只能回给用户凭证。 */
  createPairing(): Promise<{ pairingCode: string; spaceId: string }>;
  /** 轮换配对空间，旧手机失效。 */
  resetSpace(): Promise<unknown>;
};

/**
 * Claude 派单控制器的最小接口（docs/mobile-sync.md §7–8），路由在 dispatch-routes.ts。
 * `@ayanami-task/agent-dispatch` 的 AgentDispatcher 满足它；daemon 不依赖那个包，由宿主注入。
 */
export type DispatchController = {
  /** 状态，不含任何密钥：配置、claude 可执行文件、最近的派单。 */
  status(): Promise<unknown>;
  /** 部分更新配置；校验在控制器里做，不合法时抛 DISPATCH_INVALID_ARGUMENT。 */
  updateConfig(patch: unknown): Promise<unknown>;
  enqueue(input: { project: string; key: string; origin: "desktop" }): Promise<unknown>;
  cancel(run: string): Promise<unknown>;
};
