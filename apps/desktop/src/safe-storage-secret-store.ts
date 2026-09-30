import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeStorage } from "electron";
import type { SecretName, SecretStore } from "@ayanami-task/sync";

const UNAVAILABLE_REASON =
  "系统加密（Electron safeStorage / Windows DPAPI）当前不可用：为了不把中继 token 和配对密钥明文落盘，手机同步暂时不能保存密钥";

/**
 * 手机同步的密钥存储：Electron `safeStorage` 加密（Windows 上是 DPAPI，绑定当前 Windows 用户），
 * 密文以 base64 存在 `<数据目录>/sync/secrets.enc.json`。不进 Registry settings 表。
 * 系统加密不可用时拒绝写入，读取一律当作没有，状态里说明原因。
 */
export class SafeStorageSecretStore implements SecretStore {
  readonly kind = "os-encrypted" as const;
  readonly #path: string;

  constructor(directory: string) {
    this.#path = join(directory, "secrets.enc.json");
  }

  available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  unavailableReason(): string | null {
    return this.available() ? null : UNAVAILABLE_REASON;
  }

  async read(name: SecretName): Promise<string | null> {
    if (!this.available()) return null;
    const sealed = this.#load()[name];
    if (!sealed) return null;
    try {
      return safeStorage.decryptString(Buffer.from(sealed, "base64"));
    } catch {
      // 换了 Windows 用户或系统密钥轮换后解不开：当作没有，由用户重新填写。
      return null;
    }
  }

  async write(name: SecretName, value: string): Promise<void> {
    if (!this.available()) throw new Error(UNAVAILABLE_REASON);
    const sealed = safeStorage.encryptString(value).toString("base64");
    this.#save({ ...this.#load(), [name]: sealed });
  }

  async remove(name: SecretName): Promise<void> {
    const current = this.#load();
    if (!(name in current)) return;
    delete current[name];
    this.#save(current);
  }

  #load(): Record<string, string> {
    if (!existsSync(this.#path)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
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

  #save(values: Record<string, string>): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, this.#path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
