import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Add-Type 编译 C# 时，.NET 在 %TEMP% 下建一个随机 8 字符的目录放源码与程序集，编译完只删
 * 文件、留下空目录（2026-10-01 实测：每起一次探针 %TEMP% 就多一个）。烟测、探针、预算测量
 * 一轮要起几十次 PowerShell，日积月累正是拖慢登录的那种堆积。给这些 PowerShell 一个
 * output/ 下的临时根（固定前缀 + mkdtemp），用完连同目录一起删。
 */
export type PowerShellScratch = {
  env: NodeJS.ProcessEnv;
  /**
   * 删掉临时根；删成功（或早已删掉）返回 true。删不掉（被扫描、编译进程还没走）不抛：
   * 写一行诊断、返回 false，之后可以再调一次重试；没人再调的话，驱动进程退出时再删一次。
   */
  dispose(): boolean;
};

export const POWERSHELL_SCRATCH_PREFIX = "powershell-temp-";

const removeDirectory = (directory: string) =>
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * 删失败、还没删掉的临时根。调用方（探针退出回调、一次性包装器）删失败后就不会再来了，
 * 由这里在驱动进程退出时统一再删一次（Codex R7-P2-5）。退出钩子只管删目录，不结束任何进程。
 */
const pendingRemovals = new Map<string, (directory: string) => void>();
let exitRetryInstalled = false;

/** 还欠着没删掉的临时根（测试用）。 */
export function pendingScratchRemovals(): string[] {
  return [...pendingRemovals.keys()];
}

/** 把欠着的临时根再删一次；删掉的从表里划掉。返回仍删不掉的个数。 */
export function retryPendingScratchRemovals(): number {
  for (const [directory, remove] of [...pendingRemovals]) {
    try {
      remove(directory);
      pendingRemovals.delete(directory);
    } catch (error) {
      process.stderr.write(`PowerShell 临时根仍删不掉：${directory}（${describeError(error)}）\n`);
    }
  }
  return pendingRemovals.size;
}

function retryAtExit(directory: string, remove: (directory: string) => void): void {
  pendingRemovals.set(directory, remove);
  if (exitRetryInstalled) return;
  exitRetryInstalled = true;
  process.once("exit", () => void retryPendingScratchRemovals());
}

export function powershellScratch(
  root = process.cwd(),
  base: NodeJS.ProcessEnv = process.env,
  remove: (directory: string) => void = removeDirectory,
): PowerShellScratch {
  const outputRoot = resolve(root, "output");
  mkdirSync(outputRoot, { recursive: true });
  const directory = mkdtempSync(join(outputRoot, POWERSHELL_SCRATCH_PREFIX));
  let disposed = false;
  return {
    env: { ...base, TEMP: directory, TMP: directory },
    dispose() {
      if (disposed) return true;
      try {
        remove(directory);
        disposed = true;
        pendingRemovals.delete(directory);
      } catch (error) {
        process.stderr.write(
          `PowerShell 临时根删不掉，稍后再试：${directory}（${describeError(error)}）\n`,
        );
        retryAtExit(directory, remove);
      }
      return disposed;
    },
  };
}

/** 一次性调用：给它一个临时根，结束（含异步结束）后删掉；删不掉不会盖住 run 自己的结果或错误。 */
export function withPowerShellScratch<T>(
  run: (env: NodeJS.ProcessEnv) => T,
  root = process.cwd(),
): T {
  const scratch = powershellScratch(root);
  let result: T;
  try {
    result = run(scratch.env);
  } catch (error) {
    scratch.dispose();
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(() => scratch.dispose()) as T;
  }
  scratch.dispose();
  return result;
}
