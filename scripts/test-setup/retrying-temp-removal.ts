// ATM-T-0339：全量用例里的偶发失败多数不在断言，而在 afterEach 删临时目录这一步。
//
// Windows 上 SQLite 刚关闭的句柄、杀软的实时扫描都会让文件短暂处于占用状态，
// 删除得到 EPERM / EBUSY / ENOTEMPTY。Node 24 的 rmSync / rm 遇到 EPERM 并不按
// maxRetries 重试（本仓库实测过），于是一次短暂占用就把一个业务上全绿的用例判红，
// 还把目录永远留在 %TEMP% 里——这正是 2026-08 那次 %TEMP% 堆积拖垮登录的来源之一。
//
// 175 个测试文件各自写 rmSync(dir, { recursive: true, force: true })，逐个改既难审
// 又挡不住下一个新文件。这里在测试进程里集中兜底：只对系统临时目录下的递归删除、
// 只对上面三种暂时性错误做有界退避重试；其余调用原样透传，错误原样抛出。

import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export const RETRYING_REMOVAL_MARKER = Symbol.for("atm.test.retryingTempRemoval");

const TRANSIENT = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
export const REMOVAL_ATTEMPTS = 40;
export const REMOVAL_DELAY_MS = 50;

type RemoveOptions = { recursive?: boolean; force?: boolean } | undefined;

function transient(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && TRANSIENT.has(code);
}

/** 只兜底临时目录里的递归删除：别处的删除失败多半是真问题，不该被重试掩盖。 */
export function eligibleForRetry(
  path: unknown,
  options: RemoveOptions,
  temporaryRoot = tmpdir(),
): boolean {
  if (typeof path !== "string" || options?.recursive !== true) return false;
  const inside = relative(resolve(temporaryRoot), resolve(path));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function retryingRemoveSync<T extends (path: never, options?: never) => void>(
  remove: T,
  sleep: (milliseconds: number) => void = sleepSync,
  temporaryRoot?: string,
): T {
  const wrapped = ((path: string, options?: RemoveOptions) => {
    if (!eligibleForRetry(path, options, temporaryRoot)) {
      return (remove as unknown as (p: string, o?: RemoveOptions) => void)(path, options);
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        return (remove as unknown as (p: string, o?: RemoveOptions) => void)(path, options);
      } catch (error) {
        if (attempt >= REMOVAL_ATTEMPTS || !transient(error)) throw error;
        sleep(REMOVAL_DELAY_MS);
      }
    }
  }) as unknown as T;
  Object.defineProperty(wrapped, RETRYING_REMOVAL_MARKER, { value: true });
  return wrapped;
}

export function retryingRemove<T extends (path: never, options?: never) => Promise<void>>(
  remove: T,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  temporaryRoot?: string,
): T {
  const wrapped = (async (path: string, options?: RemoveOptions) => {
    if (!eligibleForRetry(path, options, temporaryRoot)) {
      return (remove as unknown as (p: string, o?: RemoveOptions) => Promise<void>)(path, options);
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await (remove as unknown as (p: string, o?: RemoveOptions) => Promise<void>)(
          path,
          options,
        );
      } catch (error) {
        if (attempt >= REMOVAL_ATTEMPTS || !transient(error)) throw error;
        await sleep(REMOVAL_DELAY_MS);
      }
    }
  }) as unknown as T;
  Object.defineProperty(wrapped, RETRYING_REMOVAL_MARKER, { value: true });
  return wrapped;
}
