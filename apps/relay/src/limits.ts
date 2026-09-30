// 中继的全部限额集中在这里，每一项都可以用环境变量覆盖（见 README「限额」）。
//
// 默认值按「一台电脑 + 几部手机」的个人用量定：ATM 自己把每片密文控制在 160 KiB 以内，
// 一个空间通常只有几十个文档。限额的作用是让一枚泄露的 token 撑不爆磁盘、也拖不垮进程，
// 不是给正常使用设门槛。

export type RelayLimits = {
  /** 请求体上限（字节），超出 413。 */
  maxBodyBytes: number;
  /** 单文档 `data` 原文上限（字节），超出 413。与 AyanamiCloud 的 256 KiB 一致。 */
  maxDataBytes: number;
  /** 每个 app 的文档数上限，超出 507。 */
  maxDocumentsPerApp: number;
  /** 每个 app 的文档总字节上限，超出 507。 */
  maxBytesPerApp: number;
  /** 每枚 token（未认证请求按来源地址）每秒请求数，令牌桶容量同值。 */
  requestsPerSecond: number;
  /** 每枚 token 同时挂起的长轮询数。 */
  waitersPerToken: number;
  /** 全进程同时挂起的长轮询数。 */
  waitersGlobal: number;
  /** 长轮询最长等待（秒）。 */
  maxWaitSeconds: number;
  /** 每个 app 保留的变更条数。 */
  changeRetentionCount: number;
  /** 变更保留天数。 */
  changeRetentionDays: number;
};

export const DEFAULT_LIMITS: Readonly<RelayLimits> = Object.freeze({
  maxBodyBytes: 300 * 1024,
  maxDataBytes: 256 * 1024,
  maxDocumentsPerApp: 5000,
  maxBytesPerApp: 200 * 1024 * 1024,
  requestsPerSecond: 20,
  waitersPerToken: 4,
  waitersGlobal: 256,
  maxWaitSeconds: 25,
  changeRetentionCount: 10_000,
  changeRetentionDays: 30,
});

/** 环境变量名与限额字段的对应关系。README 的限额表照这张表写。 */
export const LIMIT_ENV: Readonly<Record<keyof RelayLimits, string>> = Object.freeze({
  maxBodyBytes: "ATM_RELAY_MAX_BODY_BYTES",
  maxDataBytes: "ATM_RELAY_MAX_DATA_BYTES",
  maxDocumentsPerApp: "ATM_RELAY_MAX_DOCUMENTS",
  maxBytesPerApp: "ATM_RELAY_MAX_APP_BYTES",
  requestsPerSecond: "ATM_RELAY_RATE_PER_SECOND",
  waitersPerToken: "ATM_RELAY_WAITERS_PER_TOKEN",
  waitersGlobal: "ATM_RELAY_WAITERS_GLOBAL",
  maxWaitSeconds: "ATM_RELAY_MAX_WAIT_SECONDS",
  changeRetentionCount: "ATM_RELAY_CHANGE_RETENTION",
  changeRetentionDays: "ATM_RELAY_CHANGE_RETENTION_DAYS",
});

/**
 * 从环境变量读限额。值必须是正整数，否则直接报错退出——
 * 把一个写错的 `ATM_RELAY_MAX_BODY_BYTES=300k` 静默当成默认值，运维永远不会知道它没生效。
 */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): RelayLimits {
  const limits: RelayLimits = { ...DEFAULT_LIMITS };
  for (const field of Object.keys(LIMIT_ENV) as (keyof RelayLimits)[]) {
    const name = LIMIT_ENV[field];
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw.trim());
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`环境变量 ${name} 必须是正整数，实际为 ${JSON.stringify(raw)}`);
    }
    limits[field] = value;
  }
  if (limits.maxWaitSeconds > 60) {
    throw new Error(`${LIMIT_ENV.maxWaitSeconds} 不能超过 60`);
  }
  return limits;
}

/** 合并调用方给的部分限额（测试用），未给的取默认值。 */
export function resolveLimits(partial: Partial<RelayLimits> | undefined): RelayLimits {
  return { ...DEFAULT_LIMITS, ...(partial ?? {}) };
}
