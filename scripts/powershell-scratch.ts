import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Add-Type 编译 C# 时，.NET 在 %TEMP% 下建一个随机 8 字符的目录放源码与程序集，编译完只删
 * 文件、留下空目录（2026-10-01 实测：每起一次探针 %TEMP% 就多一个）。烟测、探针、预算测量
 * 一轮要起几十次 PowerShell，日积月累正是拖慢登录的那种堆积。给这些 PowerShell 一个
 * output/ 下的临时根（固定前缀 + mkdtemp），用完连同目录一起删。
 */
export type PowerShellScratch = { env: NodeJS.ProcessEnv; dispose(): void };

export const POWERSHELL_SCRATCH_PREFIX = "powershell-temp-";

export function powershellScratch(
  root = process.cwd(),
  base: NodeJS.ProcessEnv = process.env,
): PowerShellScratch {
  const outputRoot = resolve(root, "output");
  mkdirSync(outputRoot, { recursive: true });
  const directory = mkdtempSync(join(outputRoot, POWERSHELL_SCRATCH_PREFIX));
  let disposed = false;
  return {
    env: { ...base, TEMP: directory, TMP: directory },
    dispose() {
      if (disposed) return;
      disposed = true;
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** 一次性调用：给它一个临时根，结束（含异步结束）后删掉。 */
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
