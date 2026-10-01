import { createAgentDispatcher, type AgentDispatcher } from "@ayanami-task/agent-dispatch";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { DAEMON_VERSION } from "@ayanami-task/daemon";
import {
  SyncConnector,
  dispatchPortFrom,
  syncDirectory,
  taskServiceDispatchHost,
  type SecretStore,
} from "@ayanami-task/sync";
import { hostDpapi } from "./dpapi.js";
import { DpapiSecretStore } from "./dpapi-secret-store.js";

/** 手机同步与派单只写错误说明与命令 ID，不含任何密钥；core 的 console 已经改道到 stderr。 */
const mobileLogger = {
  info: () => undefined,
  warn: (message: string, meta?: Record<string, unknown>) => console.warn(`[ATM] ${message}`, meta),
  error: (message: string, meta?: Record<string, unknown>) =>
    console.error(`[ATM] ${message}`, meta),
};

export type MobileFeatures = {
  sync: SyncConnector | null;
  dispatch: AgentDispatcher | null;
  close(): Promise<void>;
};

/**
 * 同步密钥存储（DPAPI，经原生宿主）。打开时的加密→解密自检要起两次宿主，
 * 所以 startRuntime 一开始就调用，和打开数据库并行，不额外拖慢冷启动。
 */
export function openSyncSecrets(dataDir: string, hostPath: string): Promise<DpapiSecretStore> {
  const dpapi = process.platform === "win32" ? hostDpapi(hostPath) : null;
  return DpapiSecretStore.open(syncDirectory(dataDir), dpapi);
}

/**
 * 手机同步与 Claude 派单（docs/mobile-sync.md）。两者默认关闭：未启用时连接器不联网、派单不接单。
 * 它们是可选功能：创建失败不拖垮 ATM 本体，对应路由回 404 *_UNAVAILABLE。
 */
export async function startMobileFeatures(
  service: AyanamiTaskService,
  dataDir: string,
  secrets: SecretStore,
): Promise<MobileFeatures> {
  const unavailable = (feature: string) => (error: unknown) => {
    mobileLogger.error(`${feature}没有启动`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  };
  const dispatch = await createAgentDispatcher({
    dataDir,
    host: taskServiceDispatchHost(service),
    logger: mobileLogger,
  }).catch(unavailable("Claude 派单"));
  const connector = new SyncConnector({
    dataDir,
    service,
    secrets,
    appVersion: DAEMON_VERSION,
    dispatch: dispatch ? dispatchPortFrom(dispatch) : null,
    logger: mobileLogger,
  });
  const sync = await connector
    .start()
    .then(() => connector)
    .catch(unavailable("手机同步"));
  return {
    sync,
    dispatch,
    async close() {
      // 连接器停下时要写离线状态，得在关库之前。
      await sync?.stop();
      dispatch?.close();
    },
  };
}
