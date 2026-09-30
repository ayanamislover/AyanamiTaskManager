import { AtmError } from "@ayanami-task/errors";
import {
  APP_ID_PATTERN,
  RelayError,
  SpaceStore,
  deriveSpaceKeys,
  normalizeRelayUrl,
  spacePrefix,
  type RelayClient,
} from "@ayanami-task/sync-protocol";
import { z } from "zod";
import { DEVICE_NAME_MAX, type SyncConfig } from "./config.js";
import { describeError } from "./errors.js";
import type { RelayTestResult } from "./types.js";

// 设置页操作的纯逻辑：配置补丁校验、中继探测、旧空间清理，以及两个计时小工具。

const ConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    relayUrl: z.string().max(512).nullable().optional(),
    appId: z.string().max(64).optional(),
    token: z.string().max(512).optional(),
    deviceName: z.string().max(256).optional(),
  })
  .strict();

const RelayCandidateSchema = z
  .object({
    relayUrl: z.string().max(512).optional(),
    appId: z.string().max(64).optional(),
    token: z.string().max(512).optional(),
  })
  .strict();

function invalid(message: string, field: string): AtmError {
  return new AtmError("INVALID_ARGUMENT", { message, details: { field } });
}

export type ConfigChange = {
  next: SyncConfig;
  /** undefined：不动 token；null：清除；字符串：保存新 token。 */
  token: string | null | undefined;
  /** 开关、中继地址、应用 ID 或 token 变了：要重建客户端并重新探测。 */
  reconnect: boolean;
  nameChanged: boolean;
};

/** 校验 `PUT /api/v1/sync/config` 的补丁并算出新配置；全部校验通过前不产生任何副作用。 */
export function planConfigChange(
  current: SyncConfig,
  currentToken: string | null,
  patch: unknown,
): ConfigChange {
  const parsed = ConfigPatchSchema.safeParse(patch ?? {});
  if (!parsed.success)
    throw invalid("同步配置不合法：只接受 enabled、relayUrl、appId、token、deviceName", "body");
  const input = parsed.data;
  const next: SyncConfig = { ...current };
  let relayMoved = false;
  if (input.relayUrl !== undefined) {
    const raw = input.relayUrl?.trim() ?? "";
    let url: string | null = null;
    if (raw) {
      try {
        url = normalizeRelayUrl(raw);
      } catch {
        throw invalid(
          "中继地址必须是 https；只有本机调试地址（127.0.0.1 / localhost）允许 http",
          "relayUrl",
        );
      }
    }
    relayMoved ||= url !== next.relayUrl;
    next.relayUrl = url;
  }
  if (input.appId !== undefined) {
    const appId = input.appId.trim();
    if (!APP_ID_PATTERN.test(appId))
      throw invalid("应用 ID 只能是小写字母、数字、- 和 _（2–32 位）", "appId");
    relayMoved ||= appId !== next.appId;
    next.appId = appId;
  }
  let nameChanged = false;
  if (input.deviceName !== undefined) {
    const name = input.deviceName.trim();
    if (!name || name.length > DEVICE_NAME_MAX)
      throw invalid(`设备名不能为空，且不超过 ${DEVICE_NAME_MAX} 个字符`, "deviceName");
    nameChanged = name !== next.deviceName;
    next.deviceName = name;
  }
  const trimmed = input.token?.trim();
  if (trimmed && (trimmed.length < 8 || /\s/u.test(trimmed)))
    throw invalid("token 至少 8 个字符，且不能包含空白", "token");
  const token =
    trimmed === undefined || trimmed === (currentToken ?? "") ? undefined : trimmed || null;
  let reconnect = token !== undefined;
  if (input.enabled !== undefined && input.enabled !== next.enabled) {
    next.enabled = input.enabled;
    reconnect = true;
  }
  if (relayMoved) {
    // 换了中继：那边什么都没有，游标与已发布摘要都作废。
    next.cursor = null;
    next.published = {};
    next.headDigest = null;
    reconnect = true;
  }
  return { next, token, reconnect, nameChanged };
}

/** `POST /api/v1/sync/test` 的候选配置：缺的项用已保存的补上。不合法返回 null。 */
export function parseRelayCandidate(
  candidate: unknown,
): { relayUrl?: string; appId?: string; token?: string } | null {
  const parsed = RelayCandidateSchema.safeParse(candidate ?? {});
  if (!parsed.success) return null;
  const pick = (value: string | undefined) => value?.trim() || undefined;
  const relayUrl = pick(parsed.data.relayUrl);
  const appId = pick(parsed.data.appId);
  const token = pick(parsed.data.token);
  return {
    ...(relayUrl === undefined ? {} : { relayUrl }),
    ...(appId === undefined ? {} : { appId }),
    ...(token === undefined ? {} : { token }),
  };
}

/** 探测中继并计时。连不上不抛错，结果里带中文原因。 */
export async function measureProbe(makeClient: () => RelayClient): Promise<RelayTestResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const probe = await makeClient().probe();
    return {
      ok: true,
      latencyMs: elapsed(),
      longPoll: probe.longPoll,
      server: probe.version ? `${probe.server} ${probe.version}` : probe.server,
    };
  } catch (error) {
    return { ok: false, latencyMs: elapsed(), longPoll: false, error: describeError(error) };
  }
}

/** 删掉一个空间前缀下的全部文档（含分片）；返回删掉的个数。 */
export async function purgeSpace(client: RelayClient, spaceId: string): Promise<number> {
  let removed = 0;
  for (const meta of await client.listDocuments(spacePrefix(spaceId))) {
    try {
      if (await client.deleteDocument(meta.key, meta.revision)) removed += 1;
    } catch (error) {
      if (!(error instanceof RelayError) || error.status !== 409) throw error;
      const current = await client.getDocument(meta.key);
      if (current && (await client.deleteDocument(meta.key, current.revision))) removed += 1;
    }
  }
  return removed;
}

/**
 * 在（已清空的）旧空间里留撤销标记，用旧空间的密钥加密：旧手机读到就回到「需要重新配对」，
 * 而不是一直当成「电脑还没发布」，把新任务发进一个没人读的空间。
 */
export async function revokeSpace(
  client: RelayClient,
  spaceId: string,
  secret: string,
  host: { id: string; name: string },
  now: Date,
): Promise<void> {
  const store = new SpaceStore({ client, keys: await deriveSpaceKeys(secret), spaceId });
  await store.writeRevoked({ v: 1, at: now.toISOString(), host });
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 等 promise，最多 ms 毫秒；超时返回 undefined（不取消原操作）。 */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
