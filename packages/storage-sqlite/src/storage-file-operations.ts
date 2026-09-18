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

/**
 * 尽力删掉一个临时目录，删不掉也不抛错，只回报有没有删成。
 *
 * Windows 上只要还有人握着里面的句柄，rmSync 就会抛 EPERM——`force: true` 只忽略
 * 「不存在」，不忽略权限。收尾清理如果把异常抛出去，一次已经提交成功的恢复会被报成失败。
 */
export function discardDirectory(
  path: string,
  remove: (target: string) => void = (target) => rmSync(target, { recursive: true, force: true }),
): boolean {
  try {
    remove(path);
    return true;
  } catch {
    return false;
  }
}

export function removeSqliteSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}
