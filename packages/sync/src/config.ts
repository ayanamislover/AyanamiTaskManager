import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  APP_ID_PATTERN,
  COMMAND_ID_PATTERN,
  COMMAND_MAX_AGE_MS,
  DEVICE_ID_PATTERN,
  PROJECT_CODE_PATTERN,
  ProjectHeadSchema,
  SPACE_ID_PATTERN,
  commandTimestamp,
  newDeviceId,
} from "@ayanami-task/sync-protocol";

/**
 * 已处理命令 ID 记多久：按命令 ID 里内嵌的发送时间算，超过命令有效期（7 天）再加 1 天余量才忘。
 * 余量覆盖「ID 时间与 `at` 允许差 10 分钟」（validateCommand）和电脑时钟回拨；忘掉的命令再被重放，
 * 一定会因 COMMAND_EXPIRED 被拒，不会执行。手机时钟快了（ID 时间在未来）的命令记得更久，不会提前忘。
 */
export const PROCESSED_RETENTION_MS = COMMAND_MAX_AGE_MS + 24 * 60 * 60 * 1000;
/**
 * 内存与配置文件的硬上限。保留期内正常使用远到不了；真被挤掉的旧 ID 再被重放时，
 * 派单层的请求账本（agent-dispatch request-ledger，按命令 ID 持久幂等）兜底，不会再起会话，
 * 建任务也有 ATM 的 op_id 幂等。
 */
export const PROCESSED_COMMAND_LIMIT = 2_000;
export const DEFAULT_APP_ID = "atm";
export const DEVICE_NAME_MAX = 64;

const PublishedProjectSchema = z.object({
  /** 这个项目在当前空间里的键名哈希。 */
  h: z.string(),
  /** 最近一次写入的内容摘要。 */
  d: z.string(),
  head: ProjectHeadSchema,
});
export type PublishedProject = z.infer<typeof PublishedProjectSchema>;

export const SyncConfigSchema = z.object({
  v: z.literal(1),
  enabled: z.boolean(),
  relayUrl: z.string().max(512).nullable(),
  appId: z.string().regex(APP_ID_PATTERN),
  deviceId: z.string().regex(DEVICE_ID_PATTERN),
  deviceName: z.string().min(1).max(DEVICE_NAME_MAX),
  spaceId: z.string().regex(SPACE_ID_PATTERN).nullable(),
  cursor: z.string().max(512).nullable(),
  /** 项目码 → 最近一次发布的摘要与 head 条目。换空间或换中继时清空。 */
  published: z.record(z.string().regex(PROJECT_CODE_PATTERN), PublishedProjectSchema),
  headDigest: z.string().nullable(),
  processed: z.array(z.string().regex(COMMAND_ID_PATTERN)).max(PROCESSED_COMMAND_LIMIT),
  lastSyncAt: z.string().nullable(),
  lastAckSweepAt: z.string().nullable(),
});
export type SyncConfig = z.infer<typeof SyncConfigSchema>;

export type SyncConfigLogger = { warn(message: string, meta?: Record<string, unknown>): void };

export function syncDirectory(dataDir: string): string {
  return join(dataDir, "sync");
}

export function syncConfigPath(dataDir: string): string {
  return join(syncDirectory(dataDir), "config.json");
}

/** 主机名当设备名；空或超长时截断，保证能进配对码的 `n`。 */
export function defaultDeviceName(name: string = hostname()): string {
  const trimmed = name.trim();
  return (trimmed || "ATM 电脑").slice(0, DEVICE_NAME_MAX);
}

export function defaultSyncConfig(deviceName = defaultDeviceName()): SyncConfig {
  return {
    v: 1,
    enabled: false,
    relayUrl: null,
    appId: DEFAULT_APP_ID,
    deviceId: newDeviceId("pc"),
    deviceName,
    spaceId: null,
    cursor: null,
    published: {},
    headDigest: null,
    processed: [],
    lastSyncAt: null,
    lastAckSweepAt: null,
  };
}

/**
 * 读配置。文件不存在用默认值（deviceId 首次生成后写回就固定下来）；
 * 文件损坏或不合法时把原文件改名成 `config.corrupt.json` 留给排查，再用默认值。
 */
export function loadSyncConfig(
  dataDir: string,
  logger?: SyncConfigLogger,
  deviceName?: string,
): SyncConfig {
  const path = syncConfigPath(dataDir);
  if (!existsSync(path)) return defaultSyncConfig(deviceName);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    quarantine(path, logger, "同步配置文件无法解析，已回退默认配置", error);
    return defaultSyncConfig(deviceName);
  }
  const parsed = SyncConfigSchema.safeParse(raw);
  if (!parsed.success) {
    quarantine(path, logger, "同步配置文件不合法，已回退默认配置", parsed.error.issues[0]?.message);
    return defaultSyncConfig(deviceName);
  }
  return parsed.data;
}

function quarantine(
  path: string,
  logger: SyncConfigLogger | undefined,
  message: string,
  why: unknown,
) {
  const target = path.replace(/config\.json$/u, "config.corrupt.json");
  try {
    rmSync(target, { force: true });
    renameSync(path, target);
  } catch {
    // 改名失败不影响回退；下一次保存会覆盖原文件。
  }
  logger?.warn(message, { path, error: why instanceof Error ? why.message : String(why) });
}

/** 原子写：同目录临时文件 + rename，写到一半崩溃也不会留下半个 JSON。 */
export function saveSyncConfig(dataDir: string, config: SyncConfig): void {
  const directory = syncDirectory(dataDir);
  mkdirSync(directory, { recursive: true });
  const path = syncConfigPath(dataDir);
  const temporary = `${path}.${process.pid}.tmp`;
  const checked = SyncConfigSchema.parse(config);
  try {
    writeFileSync(temporary, `${JSON.stringify(checked, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * 记下已处理的命令 ID，同时忘掉发送时间早于保留期的（见 {@link PROCESSED_RETENTION_MS}）；
 * 仍超出硬上限时丢最早记下的。不是按条数滚动：旧窗口只留 500 条，7 天内再处理 500 条命令，
 * 早先的 ID 就被挤掉，重放原密文会被当成新命令再执行一次。
 */
export function rememberProcessed(config: SyncConfig, commandId: string, now: Date): SyncConfig {
  const cutoff = now.getTime() - PROCESSED_RETENTION_MS;
  const kept = config.processed.filter((id) => {
    const sentAt = commandTimestamp(id);
    return sentAt === null || sentAt >= cutoff;
  });
  if (!kept.includes(commandId)) kept.push(commandId);
  const processed = kept.slice(-PROCESSED_COMMAND_LIMIT);
  if (
    processed.length === config.processed.length &&
    processed.every((id, index) => id === config.processed[index])
  )
    return config;
  return { ...config, processed };
}
