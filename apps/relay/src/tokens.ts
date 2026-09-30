// 应用与 token。服务端只存 token 的 SHA-256；明文只在签发时出现一次。
import { createHash, randomBytes } from "node:crypto";
import { type Database, nowIso, transaction } from "./database.js";

export const APP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const TOKEN_PREFIX = "atr_";
export const DEFAULT_APP_ID = "atm";
export const DEFAULT_APP_NAME = "AyanamiTaskManager";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 小写 base32，不含易混的 0/1/8/9，适合人抄写前缀。 */
function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE32[bytes[i]! & 31];
  return out;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type AppRow = { id: string; name: string; description: string; created_at: string };

/** 与 AyanamiCloud 的 AppToken 同形；中继的 token 不绑定设备，device_id 恒为 null。 */
export type TokenView = {
  id: string;
  app_id: string;
  label: string;
  prefix: string;
  device_id: null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type TokenRow = Omit<TokenView, "device_id">;

function toView(row: TokenRow): TokenView {
  return {
    id: row.id,
    app_id: row.app_id,
    label: row.label,
    prefix: row.prefix,
    device_id: null,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

export class RelayAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayAdminError";
  }
}

export function getApp(db: Database, id: string): AppRow | undefined {
  return db.prepare("SELECT id, name, description, created_at FROM apps WHERE id = ?").get(id) as
    | AppRow
    | undefined;
}

export function createApp(db: Database, id: string, name: string): AppRow {
  if (!APP_ID_PATTERN.test(id)) {
    throw new RelayAdminError(
      "应用 ID 只能是小写字母、数字、下划线与连字符，首字符为字母或数字，长度 2–32",
    );
  }
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 100) throw new RelayAdminError("应用名长度须为 1–100");
  return transaction(db, () => {
    if (getApp(db, id)) throw new RelayAdminError(`应用 ${id} 已存在`);
    const row: AppRow = { id, name: trimmed, description: "", created_at: nowIso() };
    db.prepare("INSERT INTO apps (id, name, description, created_at) VALUES (?, ?, ?, ?)").run(
      row.id,
      row.name,
      row.description,
      row.created_at,
    );
    return row;
  });
}

export type AppSummary = AppRow & {
  document_count: number;
  storage_bytes: number;
  active_tokens: number;
};

export function listApps(db: Database): AppSummary[] {
  return db
    .prepare(
      `SELECT a.id, a.name, a.description, a.created_at,
              (SELECT COUNT(*) FROM documents d WHERE d.app_id = a.id) AS document_count,
              (SELECT IFNULL(SUM(d.size_bytes), 0) FROM documents d WHERE d.app_id = a.id) AS storage_bytes,
              (SELECT COUNT(*) FROM tokens t WHERE t.app_id = a.id AND t.revoked_at IS NULL) AS active_tokens
         FROM apps a ORDER BY a.created_at, a.id`,
    )
    .all() as AppSummary[];
}

export type IssuedToken = { token: TokenView; plaintext: string };

export function createToken(db: Database, appId: string, label: string): IssuedToken {
  const trimmed = label.trim();
  if (trimmed === "" || trimmed.length > 100) throw new RelayAdminError("token 标签长度须为 1–100");
  if (!getApp(db, appId)) {
    throw new RelayAdminError(`应用 ${appId} 不存在（先用 app create 建立，或检查 --app）`);
  }
  // 形如 atr_<前缀8>_<秘密32>：前缀用于在 token list 里认出是哪一枚，秘密部分约 160 位熵。
  const prefix = `${TOKEN_PREFIX}${randomBase32(8)}`;
  const plaintext = `${prefix}_${randomBase32(32)}`;
  const row: TokenRow = {
    id: `tok_${randomBase32(16)}`,
    app_id: appId,
    label: trimmed,
    prefix,
    created_at: nowIso(),
    last_used_at: null,
    revoked_at: null,
  };
  db.prepare(
    `INSERT INTO tokens (id, app_id, label, token_hash, prefix, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.app_id, row.label, hashToken(plaintext), row.prefix, row.created_at);
  return { token: toView(row), plaintext };
}

export function listTokens(db: Database, appId?: string): TokenView[] {
  const columns = "id, app_id, label, prefix, created_at, last_used_at, revoked_at";
  const rows =
    appId === undefined
      ? db.prepare(`SELECT ${columns} FROM tokens ORDER BY created_at DESC, id`).all()
      : db
          .prepare(`SELECT ${columns} FROM tokens WHERE app_id = ? ORDER BY created_at DESC, id`)
          .all(appId);
  return (rows as TokenRow[]).map(toView);
}

/** 撤销。返回 "revoked"、"already"（早已撤销）或 "missing"。 */
export function revokeToken(db: Database, id: string): "revoked" | "already" | "missing" {
  const row = db.prepare("SELECT revoked_at FROM tokens WHERE id = ?").get(id) as
    | { revoked_at: string | null }
    | undefined;
  if (!row) return "missing";
  if (row.revoked_at !== null) return "already";
  db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
    nowIso(),
    id,
  );
  return "revoked";
}

export type Principal = { tokenId: string; appId: string };

/**
 * 按哈希查 token。每次请求都查库、不做缓存：`token revoke` 在另一个进程里执行，
 * 撤销必须立即生效，缓存一分钟就等于给泄露的 token 多开一分钟的门。
 */
export function authenticate(db: Database, token: string): Principal | null {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const row = db
    .prepare(
      `SELECT t.id AS token_id, t.app_id AS app_id FROM tokens t JOIN apps a ON a.id = t.app_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    )
    .get(hashToken(token)) as { token_id: string; app_id: string } | undefined;
  return row ? { tokenId: row.token_id, appId: row.app_id } : null;
}

export function touchToken(db: Database, tokenId: string, at: string): void {
  db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(at, tokenId);
}

export function getMeta(db: Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
