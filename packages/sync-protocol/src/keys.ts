import { randomBytes, toHex } from "./encoding.js";
import { SyncProtocolError } from "./errors.js";

/** 与 AyanamiCloud 应用数据的键约束一致。 */
export const DOC_KEY_PATTERN = /^[A-Za-z0-9_./-]{1,200}$/;
export const APP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const SPACE_ID_PATTERN = /^[0-9a-f]{24}$/;
export const DEVICE_ID_PATTERN = /^(pc|m)-[0-9a-f]{12}$/;
export const COMMAND_ID_PATTERN = /^(pc|m)-[0-9a-f]{12}\.[0-9a-z]{13}[0-9a-f]{8}$/;
export const PROJECT_HASH_PATTERN = /^[0-9a-f]{20}$/;
export const PROJECT_CODE_PATTERN = /^[A-Z][A-Z0-9_-]{0,31}$/;
export const TASK_KEY_PATTERN = /^[A-Z][A-Z0-9_-]{0,31}-T-\d{4,}$/;

export const KEY_PREFIX = "atm1";
/** 分片后缀最多三位数字；命令 ID 里的点后面是 21 位，不会被误认成分片。 */
const PART_SUFFIX = /\.(\d{1,3})$/;

export type DeviceKind = "pc" | "m";

export function newSpaceId(): string {
  return toHex(randomBytes(12));
}

export function newDeviceId(kind: DeviceKind): string {
  return `${kind}-${toHex(randomBytes(6))}`;
}

export function newCommandId(deviceId: string, now: number = Date.now()): string {
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new SyncProtocolError("KEY_INVALID", deviceId);
  return `${deviceId}.${now.toString(36).padStart(13, "0")}${toHex(randomBytes(4))}`;
}

function checkSpace(spaceId: string): string {
  if (!SPACE_ID_PATTERN.test(spaceId)) throw new SyncProtocolError("KEY_INVALID", "spaceId");
  return `${KEY_PREFIX}/${spaceId}`;
}

export function spacePrefix(spaceId: string): string {
  return `${checkSpace(spaceId)}/`;
}

export function headKey(spaceId: string): string {
  return `${checkSpace(spaceId)}/head`;
}

export function projectKey(spaceId: string, hash: string): string {
  if (!PROJECT_HASH_PATTERN.test(hash)) throw new SyncProtocolError("KEY_INVALID", "projectHash");
  return `${checkSpace(spaceId)}/p/${hash}`;
}

export function commandKey(spaceId: string, commandId: string): string {
  if (!COMMAND_ID_PATTERN.test(commandId)) throw new SyncProtocolError("KEY_INVALID", "commandId");
  return `${checkSpace(spaceId)}/cmd/${commandId}`;
}

export function ackKey(spaceId: string, commandId: string): string {
  if (!COMMAND_ID_PATTERN.test(commandId)) throw new SyncProtocolError("KEY_INVALID", "commandId");
  return `${checkSpace(spaceId)}/ack/${commandId}`;
}

export function deviceKey(spaceId: string, deviceId: string): string {
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new SyncProtocolError("KEY_INVALID", "deviceId");
  return `${checkSpace(spaceId)}/dev/${deviceId}`;
}

export function partKey(logicalKey: string, index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 999) {
    throw new SyncProtocolError("KEY_INVALID", "part");
  }
  return `${logicalKey}.${index}`;
}

export type KeyKind =
  | { kind: "head" }
  | { kind: "project"; hash: string }
  | { kind: "command"; id: string }
  | { kind: "ack"; id: string }
  | { kind: "device"; id: string };

export type ClassifiedKey = KeyKind & { logicalKey: string; part: number };

/** 把中继上的键归类；不属于这个空间或格式不对的返回 null。 */
export function classifyKey(spaceId: string, key: string): ClassifiedKey | null {
  if (!SPACE_ID_PATTERN.test(spaceId) || !DOC_KEY_PATTERN.test(key)) return null;
  const prefix = spacePrefix(spaceId);
  if (!key.startsWith(prefix)) return null;
  let logicalKey = key;
  let part = 0;
  const suffix = PART_SUFFIX.exec(key);
  if (suffix?.[1]) {
    part = Number(suffix[1]);
    if (part < 1) return null;
    logicalKey = key.slice(0, suffix.index);
  }
  const rest = logicalKey.slice(prefix.length);
  if (rest === "head") return { kind: "head", logicalKey, part };
  const [group, id, ...extra] = rest.split("/");
  if (!id || extra.length > 0) return null;
  switch (group) {
    case "p":
      return PROJECT_HASH_PATTERN.test(id) ? { kind: "project", hash: id, logicalKey, part } : null;
    case "cmd":
      return COMMAND_ID_PATTERN.test(id) ? { kind: "command", id, logicalKey, part } : null;
    case "ack":
      return COMMAND_ID_PATTERN.test(id) ? { kind: "ack", id, logicalKey, part } : null;
    case "dev":
      return DEVICE_ID_PATTERN.test(id) ? { kind: "device", id, logicalKey, part } : null;
    default:
      return null;
  }
}

/** 从命令 ID 里取出发送时间（毫秒），格式不对返回 null。 */
export function commandTimestamp(commandId: string): number | null {
  if (!COMMAND_ID_PATTERN.test(commandId)) return null;
  const stamp = commandId.split(".")[1]?.slice(0, 13);
  return stamp ? Number.parseInt(stamp, 36) : null;
}
