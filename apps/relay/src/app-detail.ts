// GET /v1/apps/{app} 的响应：AyanamiCloud 的 AppDetail 全部字段，外加 relay 能力声明。
import type { Database } from "./database.js";
import type { DocumentMeta } from "./documents.js";
import type { RelayLimits } from "./limits.js";
import { type AppRow, listTokens } from "./tokens.js";
import { RELAY_NAME, RELAY_VERSION } from "./version.js";

/** 「connected」= 30 天内有未撤销的 token 用过，与 AyanamiCloud 的推导相同。 */
const CONNECTED_WINDOW_MS = 30 * 24 * 3600 * 1000;
const DEVICE_PREFIX = "devices/";

function deviceIdFromKey(key: string): string {
  if (!key.startsWith(DEVICE_PREFIX)) return "";
  const rest = key.slice(DEVICE_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(0, slash) : "";
}

export function appDetail(
  db: Database,
  app: AppRow,
  limits: RelayLimits,
  now: number = Date.now(),
): Record<string, unknown> {
  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM documents WHERE app_id = ?) AS document_count,
              (SELECT IFNULL(SUM(size_bytes), 0) FROM documents WHERE app_id = ?) AS storage_bytes,
              (SELECT MAX(at) FROM changes WHERE app_id = ?) AS last_sync_at,
              (SELECT MAX(last_used_at) FROM tokens WHERE app_id = ? AND revoked_at IS NULL) AS last_used`,
    )
    .get(app.id, app.id, app.id, app.id) as {
    document_count: number;
    storage_bytes: number;
    last_sync_at: string | null;
    last_used: string | null;
  };
  const lastUsed = stats.last_used === null ? Number.NaN : Date.parse(stats.last_used);
  const status =
    Number.isFinite(lastUsed) && now - lastUsed <= CONNECTED_WINDOW_MS ? "connected" : "pending";

  // shared_documents 与 AyanamiCloud 一样取按键排序的前 500 个、去掉 devices/ 前缀；
  // 中继没有设备登记，devices/ 前缀只是普通键，这里仍按同样规则分桶，保证字段语义一致。
  const firstPage = db
    .prepare(
      `SELECT key, schema_version, revision, updated_at, updated_by_device, size_bytes
         FROM documents WHERE app_id = ? ORDER BY key LIMIT 500`,
    )
    .all(app.id) as DocumentMeta[];
  const deviceKeys = db
    .prepare(
      "SELECT key FROM documents WHERE app_id = ? AND key >= 'devices/' AND key < 'devices0'",
    )
    .all(app.id) as { key: string }[];
  const deviceDocumentCounts: Record<string, number> = {};
  for (const { key } of deviceKeys) {
    const device = deviceIdFromKey(key);
    if (device !== "") deviceDocumentCounts[device] = (deviceDocumentCounts[device] ?? 0) + 1;
  }

  return {
    id: app.id,
    name: app.name,
    description: app.description,
    status,
    device_count: 0,
    document_count: stats.document_count,
    conflict_count: 0,
    storage_bytes: stats.storage_bytes,
    last_sync_at: stats.last_sync_at,
    created_at: app.created_at,
    devices: [],
    tokens: listTokens(db, app.id).map((token) => ({
      id: token.id,
      label: token.label,
      prefix: token.prefix,
      device_id: token.device_id,
      created_at: token.created_at,
      last_used_at: token.last_used_at,
      revoked_at: token.revoked_at,
    })),
    shared_documents: firstPage
      .filter((doc) => !doc.key.startsWith(DEVICE_PREFIX))
      .map((doc) => ({ ...doc })),
    device_document_counts: deviceDocumentCounts,
    relay: {
      name: RELAY_NAME,
      version: RELAY_VERSION,
      long_poll: true,
      max_wait: limits.maxWaitSeconds,
    },
  };
}
