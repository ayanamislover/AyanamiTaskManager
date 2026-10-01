import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** 派单在数据目录下的全部落盘位置。 */
export function dispatchPaths(dataDir: string) {
  const root = join(dataDir, "dispatch");
  return {
    root,
    config: join(root, "config.json"),
    runs: join(root, "runs.json"),
    /** 派单请求账本：requestId（手机命令 ID）→ 那次请求的结局，见 request-ledger.ts。 */
    requests: join(root, "requests.json"),
    logs: join(root, "logs"),
    stdoutLog: (run: string) => join(root, "logs", `${run}.jsonl`),
    stderrLog: (run: string) => join(root, "logs", `${run}.stderr.log`),
  };
}

export type DispatchPaths = ReturnType<typeof dispatchPaths>;

/**
 * 原子写 JSON：先写同目录临时文件再改名覆盖。Windows 上目标文件偶尔被杀毒/索引短暂占用，
 * 改名会 EPERM/EBUSY，做几次有界重试；最终失败时删掉临时文件再抛出。
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        // 同步短等：原子写只在状态变化时发生，次数很少，不值得为它把整条调用链改成异步。
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
        continue;
      }
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

export type JsonReadResult =
  | { kind: "missing" }
  | { kind: "ok"; value: unknown }
  | { kind: "corrupt"; error: string };

export function readJsonFile(path: string): JsonReadResult {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    return { kind: "ok", value: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch (error) {
    return { kind: "corrupt", error: error instanceof Error ? error.message : String(error) };
  }
}

/** 读文件末尾至多 `maxBytes` 字节；文件不存在返回空串。 */
export function readTail(path: string, maxBytes = 1024 * 1024): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
