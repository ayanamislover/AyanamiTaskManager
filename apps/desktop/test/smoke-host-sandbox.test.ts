import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSandboxDataDir, smokeHostEnvironment } from "../../../scripts/smoke-host.js";

// 手动烟测（窗口、历史、毛玻璃、登录启动、bridge 内存）共用这道闸：数据根只能在 output/ 下，
// 真实数据根与真实安装连同它们的子目录一律拒绝。历史烟测以前就是直接开用户真实数据根的。
let scratch: string | null = null;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

function layout() {
  scratch = mkdtempSync(join(tmpdir(), "atm-smoke-sandbox-guard-"));
  const output = join(scratch, "repo", "output");
  const real = join(scratch, "Local", "AyanamiTaskManager");
  const install = join(scratch, "Local", "AyanamiTaskManagerDesktop");
  for (const directory of [output, real, install]) mkdirSync(directory, { recursive: true });
  return { output, real, install, options: { outputRoot: output, realRoots: [real, install] } };
}

describe("烟测数据根沙箱", () => {
  it("output/ 下的子目录放行", () => {
    const { output, options } = layout();
    expect(assertSandboxDataDir(join(output, "history-smoke-data"), options)).toBe(
      join(output, "history-smoke-data"),
    );
  });

  it("真实数据根、真实安装及其子目录拒绝（大小写不敏感）", () => {
    const { real, install, options } = layout();
    for (const candidate of [real, real.toUpperCase(), join(real, "sub"), install])
      expect(() => assertSandboxDataDir(candidate, options)).toThrow(/真实数据根/u);
  });

  it("output/ 本身与 output/ 以外的路径拒绝", () => {
    const { output, options } = layout();
    expect(() => assertSandboxDataDir(output, options)).toThrow(/之下/u);
    expect(() => assertSandboxDataDir(join(output, "..", "elsewhere"), options)).toThrow(/之下/u);
  });

  it("output/ 里的 junction 接到真实数据根也拒绝", () => {
    const { output, real, options } = layout();
    symlinkSync(real, join(output, "linked"), "junction");
    expect(() => assertSandboxDataDir(join(output, "linked", "data"), options)).toThrow(
      /真实数据根/u,
    );
  });

  it("宿主环境去掉继承的数据根别名，Node 子进程拿合成 home", () => {
    const previous = process.env.AYANAMI_TASK_DATA_DIR;
    process.env.AYANAMI_TASK_DATA_DIR = "C:\\real";
    try {
      const env = smokeHostEnvironment("C:\\sandbox\\data", "C:\\sandbox\\home");
      expect(env.ATM_DATA_DIR).toBe("C:\\sandbox\\data");
      expect(env.AYANAMI_TASK_DATA_DIR).toBeUndefined();
      expect(env.ATM_SMOKE_CORE_USERPROFILE).toBe("C:\\sandbox\\home");
      expect(env.APPDATA).toBe(join("C:\\sandbox\\home", "Roaming"));
      expect(env.LOCALAPPDATA).toBe(join("C:\\sandbox\\home", "Local"));
    } finally {
      if (previous === undefined) delete process.env.AYANAMI_TASK_DATA_DIR;
      else process.env.AYANAMI_TASK_DATA_DIR = previous;
    }
  });
});
