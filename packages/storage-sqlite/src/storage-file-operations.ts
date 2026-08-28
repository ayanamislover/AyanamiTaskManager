import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const TRANSIENT_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

export async function renameWithRetry(source: string, destination: string): Promise<void> {
  const attempts = process.platform === "win32" ? 8 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT_RENAME_ERRORS.has(code) || attempt === attempts - 1) throw error;
      await delay(25 * 2 ** attempt);
    }
  }
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function removeSqliteSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}
