import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { AtmError } from "@ayanami-task/errors";

/**
 * 连接器要落盘的两项密钥。都不进 Registry 的 settings 表（那张表 Agent 令牌可读），
 * 只经宿主提供的 {@link SecretStore} 保存。
 */
export const SECRET_NAMES = {
  /** 中继 token。 */
  relayToken: "relay-token",
  /** 空间密钥，存成 `<spaceId>:<secret>`，读出时核对空间 ID，防止配置与密钥错配。 */
  spaceSecret: "space-secret",
} as const;

export type SecretName = (typeof SECRET_NAMES)[keyof typeof SECRET_NAMES];

/**
 * 密钥存储端口。桌面端用 Electron `safeStorage`（DPAPI）实现，标 `os-encrypted`；
 * 独立 daemon（开发 / e2e）用 {@link FileSecretStore}，明文落盘并如实标 `plaintext`。
 */
export type SecretStore = {
  readonly kind: "os-encrypted" | "plaintext";
  /** 系统加密不可用等情况返回 false；此时 write 必须拒绝，状态里会说明原因。 */
  available?(): boolean;
  /** 不可用时给用户看的原因（中文）。 */
  unavailableReason?(): string | null;
  read(name: SecretName): Promise<string | null>;
  write(name: SecretName, value: string): Promise<void>;
  remove(name: SecretName): Promise<void>;
};

const SECRET_FILE = "secrets.json";

function readSecretsFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/**
 * 明文 JSON 文件（`<目录>/secrets.json`，权限 0600）。只给独立 daemon、开发与 e2e 用；
 * 状态里标 `plaintext`，界面据此提示「密钥未加密」。
 */
export class FileSecretStore implements SecretStore {
  readonly kind = "plaintext" as const;
  readonly #path: string;

  constructor(directory: string) {
    this.#path = join(directory, SECRET_FILE);
  }

  get path(): string {
    return this.#path;
  }

  async read(name: SecretName): Promise<string | null> {
    return readSecretsFile(this.#path)[name] ?? null;
  }

  async write(name: SecretName, value: string): Promise<void> {
    this.#save({ ...readSecretsFile(this.#path), [name]: value });
  }

  async remove(name: SecretName): Promise<void> {
    const current = readSecretsFile(this.#path);
    if (!(name in current)) return;
    delete current[name];
    this.#save(current);
  }

  #save(values: Record<string, string>): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, this.#path);
      // Windows 上 mode 基本不起作用；POSIX 上补一次，防止旧文件权限过宽。
      if (process.platform !== "win32") chmodSync(this.#path, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

/** 空间密钥连同空间 ID 一起存，读出时核对，错配（例如写到一半崩溃）按「没有空间」处理。 */
export function encodeSpaceSecret(spaceId: string, secret: string): string {
  return `${spaceId}:${secret}`;
}

export function decodeSpaceSecret(value: string | null, spaceId: string | null): string | null {
  if (value === null || spaceId === null) return null;
  const separator = value.indexOf(":");
  if (separator <= 0 || value.slice(0, separator) !== spaceId) return null;
  const secret = value.slice(separator + 1);
  return secret.length > 0 ? secret : null;
}

const UNAVAILABLE_FALLBACK = "系统加密不可用，不能保存同步密钥（不会明文落盘）";

/**
 * 连接器持有的密钥：启动时从 {@link SecretStore} 读一次，之后留在内存里（不进状态、不进日志）。
 * 写入前检查系统加密是否可用，不可用就拒绝，绝不退回明文。
 */
export class SecretVault {
  readonly #store: SecretStore;
  #loaded = false;
  /** 中继 token；没有为 null。 */
  token: string | null = null;
  /** 当前配对空间的密钥（已核对空间 ID）；没有为 null。 */
  secret: string | null = null;
  /** 读取失败的原因（中文），给状态用。 */
  loadError: string | null = null;

  constructor(store: SecretStore) {
    this.#store = store;
  }

  /** 状态接口里的取值：桌面端 safeStorage，独立 daemon 明文文件。 */
  get statusKind(): "safeStorage" | "plaintext" {
    return this.#store.kind === "plaintext" ? "plaintext" : "safeStorage";
  }

  /** 系统加密不可用时的原因；可用时为 null。 */
  unavailableReason(): string | null {
    if (this.#store.available?.() !== false) return null;
    return this.#store.unavailableReason?.() ?? UNAVAILABLE_FALLBACK;
  }

  async load(spaceId: string | null): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      this.token = (await this.#store.read(SECRET_NAMES.relayToken)) || null;
      this.secret = decodeSpaceSecret(await this.#store.read(SECRET_NAMES.spaceSecret), spaceId);
    } catch (error) {
      this.loadError = `读取同步密钥失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  assertWritable(): void {
    const reason = this.unavailableReason();
    if (reason === null) return;
    throw new AtmError("VALIDATION_ERROR", {
      message: reason,
      details: { reason: "SECRET_STORE_UNAVAILABLE" },
    });
  }

  /** null 表示清除。 */
  async setToken(token: string | null): Promise<void> {
    if (token) {
      this.assertWritable();
      await this.#store.write(SECRET_NAMES.relayToken, token);
    } else {
      await this.#store.remove(SECRET_NAMES.relayToken);
    }
    this.token = token;
  }

  async setSpace(spaceId: string, secret: string): Promise<void> {
    this.assertWritable();
    await this.#store.write(SECRET_NAMES.spaceSecret, encodeSpaceSecret(spaceId, secret));
    this.secret = secret;
  }
}
