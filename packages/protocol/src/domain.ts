import { z } from "zod";

export const SESSION_CLOSE_REASONS = [
  "HEARTBEAT_TIMEOUT",
  "EXPLICIT_END",
  "EXPLICIT_RETIRE",
  "FORCE_CLOSE",
] as const;
export const SessionCloseReasonSchema = z.enum(SESSION_CLOSE_REASONS);
export type SessionCloseReason = z.infer<typeof SessionCloseReasonSchema>;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createUlid(time = Date.now(), entropy?: Uint8Array): string {
  if (!Number.isSafeInteger(time) || time < 0 || time > 0xffffffffffff) {
    throw new Error("ULID_TIME_OUT_OF_RANGE");
  }
  const random = entropy ?? crypto.getRandomValues(new Uint8Array(10));
  if (random.length !== 10) throw new Error("ULID_ENTROPY_LENGTH");
  let randomness = 0n;
  for (const byte of random) randomness = (randomness << 8n) | BigInt(byte);
  let value = (BigInt(time) << 80n) | randomness;
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return encoded;
}

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export const PROJECT_LIFECYCLES = [
  "CREATING",
  "ACTIVE",
  "ARCHIVED",
  "RESTORING",
  "MIGRATION_FAILED",
  "TRASHED",
] as const;
export const ProjectLifecycleSchema = z.enum(PROJECT_LIFECYCLES);
export type ProjectLifecycle = z.infer<typeof ProjectLifecycleSchema>;

export const COORDINATION_MODES = ["SOLO", "AUTO", "MULTI"] as const;
export const CoordinationModeSchema = z.enum(COORDINATION_MODES);
export type CoordinationMode = z.infer<typeof CoordinationModeSchema>;

export const PROJECT_HEALTH = ["ON_TRACK", "AT_RISK", "OFF_TRACK", "UNKNOWN"] as const;
export const ProjectHealthSchema = z.enum(PROJECT_HEALTH);
export type ProjectHealth = z.infer<typeof ProjectHealthSchema>;

export const RECORD_KINDS = [
  "DECISION",
  "CONSTRAINT",
  "FACT",
  "RISK",
  "REFERENCE",
  "LESSON",
  "VERIFICATION",
  "WAIVER",
] as const;
export const RecordKindSchema = z.enum(RECORD_KINDS);
export type RecordKind = z.infer<typeof RecordKindSchema>;

export const ATM_FEEDBACK_RECORD_SCOPE = "ATM_FEEDBACK";

/**
 * 这些 scope 的 Record 讲的是 ATM 这个产品，不是所在项目的事实，因此不进 brief。
 *
 * brief 只按 kind + importance 选取（context-read-model.ts），而 atm_feedback 落的是
 * RISK：severity=HIGH/CRITICAL 的产品反馈会被后续每个 Session 当成项目风险读到，
 * 还会按更新时间把更早的真实 CONSTRAINT 挤出名额。写在这里而不是 SQL 里，
 * 是为了让写入端（atm_feedback）和过滤端指向同一个常量。
 */
export const BRIEF_EXCLUDED_RECORD_SCOPES = [ATM_FEEDBACK_RECORD_SCOPE] as const;

export const PROJECT_HEALTH_LABELS: Record<ProjectHealth, string> = {
  ON_TRACK: "进展正常",
  AT_RISK: "存在风险",
  OFF_TRACK: "偏离计划",
  UNKNOWN: "尚未判断",
};
