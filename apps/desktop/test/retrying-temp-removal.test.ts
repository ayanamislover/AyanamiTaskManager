import { rmSync as importedRmSync } from "node:fs";
import { rm as importedRm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  eligibleForRetry,
  REMOVAL_ATTEMPTS,
  RETRYING_REMOVAL_MARKER,
  retryingRemove,
  retryingRemoveSync,
} from "../../../scripts/test-setup/retrying-temp-removal.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

const temporaryRoot = join(tmpdir(), "atm-retry-root");
const inside = join(temporaryRoot, "fixture");

// ATM-T-0339：8 轮全量里有 3 轮各挂一条，三条都挂在 afterEach 删临时目录（EPERM×2、ENOTEMPTY×1），
// 业务断言本身全绿。
describe("测试进程里的临时目录删除", () => {
  it("测试文件里的 rmSync / rm 具名导入拿到的就是带重试的版本", () => {
    expect((importedRmSync as unknown as Record<symbol, unknown>)[RETRYING_REMOVAL_MARKER]).toBe(
      true,
    );
    expect((importedRm as unknown as Record<symbol, unknown>)[RETRYING_REMOVAL_MARKER]).toBe(true);
  });

  it("暂时性占用会重试直到删掉；不属于暂时性的错误立即抛出", async () => {
    for (const code of ["EPERM", "EBUSY", "ENOTEMPTY"]) {
      let calls = 0;
      const remove = retryingRemoveSync(
        (() => {
          calls += 1;
          if (calls < 3) throw errno(code);
        }) as (path: string, options?: { recursive?: boolean }) => void,
        () => undefined,
        temporaryRoot,
      );
      remove(inside, { recursive: true });
      expect(calls).toBe(3);
    }
    let asyncCalls = 0;
    const removeAsync = retryingRemove(
      (async () => {
        asyncCalls += 1;
        if (asyncCalls < 2) throw errno("EPERM");
      }) as (path: string, options?: { recursive?: boolean }) => Promise<void>,
      async () => undefined,
      temporaryRoot,
    );
    await removeAsync(inside, { recursive: true });
    expect(asyncCalls).toBe(2);

    let fatalCalls = 0;
    const fatal = retryingRemoveSync(
      (() => {
        fatalCalls += 1;
        throw errno("EACCES");
      }) as (path: string, options?: { recursive?: boolean }) => void,
      () => undefined,
      temporaryRoot,
    );
    expect(() => fatal(inside, { recursive: true })).toThrow("EACCES");
    expect(fatalCalls).toBe(1);
  });

  it("重试有上限：一直被占用时最终照样抛出，不会卡死用例", () => {
    let calls = 0;
    const remove = retryingRemoveSync(
      (() => {
        calls += 1;
        throw errno("EPERM");
      }) as (path: string, options?: { recursive?: boolean }) => void,
      () => undefined,
      temporaryRoot,
    );
    expect(() => remove(inside, { recursive: true })).toThrow("EPERM");
    expect(calls).toBe(REMOVAL_ATTEMPTS);
  });

  it("只兜底临时目录下的递归删除：别处或非递归的删除失败不被掩盖", () => {
    expect(eligibleForRetry(inside, { recursive: true }, temporaryRoot)).toBe(true);
    expect(eligibleForRetry(temporaryRoot, { recursive: true }, temporaryRoot)).toBe(false);
    expect(eligibleForRetry(inside, { recursive: false }, temporaryRoot)).toBe(false);
    expect(eligibleForRetry(inside, undefined, temporaryRoot)).toBe(false);
    expect(
      eligibleForRetry(join(process.cwd(), "output", "x"), { recursive: true }, temporaryRoot),
    ).toBe(false);
    expect(eligibleForRetry(`${temporaryRoot}-sibling`, { recursive: true }, temporaryRoot)).toBe(
      false,
    );

    let calls = 0;
    const remove = retryingRemoveSync(
      (() => {
        calls += 1;
        throw errno("EPERM");
      }) as (path: string, options?: { recursive?: boolean }) => void,
      () => undefined,
      temporaryRoot,
    );
    expect(() => remove(join(process.cwd(), "output", "x"), { recursive: true })).toThrow("EPERM");
    expect(calls).toBe(1);
  });
});
