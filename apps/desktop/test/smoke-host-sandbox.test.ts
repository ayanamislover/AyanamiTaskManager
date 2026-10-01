import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSandboxDataDir,
  exited,
  smokeExecutable,
  smokeHostEnvironment,
} from "../../../scripts/smoke-host.js";

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

describe("烟测宿主与子进程", () => {
  // 生产宿主也能带 portable 标记，可它不隔离 Node 子进程的 home；装进安装根的版本目录还会走
  // 安装准入。两种都要在启动前拒。
  it("只接受 smoke 构建、且不在一份安装里的宿主", () => {
    scratch = mkdtempSync(join(tmpdir(), "atm-smoke-host-guard-"));
    const host = (parent: string, bytes: string) => {
      const versionDir = join(scratch!, parent, "app-9.9.9");
      mkdirSync(versionDir, { recursive: true });
      writeFileSync(join(versionDir, "portable"), "");
      writeFileSync(join(versionDir, "AyanamiTaskManager.exe"), bytes);
      return join(versionDir, "AyanamiTaskManager.exe");
    };
    const previous = process.env.ATM_PACKAGED_EXE;
    try {
      process.env.ATM_PACKAGED_EXE = host("production", "MZ production host");
      expect(() => smokeExecutable()).toThrow(/SMOKE_HOST_WITHOUT_SMOKE_FEATURE/u);
      process.env.ATM_PACKAGED_EXE = host("installed", "MZ --remote-debugging-port=0");
      writeFileSync(join(scratch, "installed", "app.json"), "{}");
      expect(() => smokeExecutable()).toThrow(/不能放在一份安装里/u);
      const smoke = host("smoke", "MZ --remote-debugging-port=0");
      process.env.ATM_PACKAGED_EXE = smoke;
      expect(smokeExecutable()).toBe(smoke);
    } finally {
      if (previous === undefined) delete process.env.ATM_PACKAGED_EXE;
      else process.env.ATM_PACKAGED_EXE = previous;
    }
  });

  // 被信号结束的子进程 exitCode 是 null：只看 exitCode 会以为它还活着，再去按旧 PID 结束进程树。
  it("被信号结束的子进程也算退出", () => {
    const child = (exitCode: number | null, signalCode: NodeJS.Signals | null) =>
      ({ exitCode, signalCode }) as unknown as ChildProcess;
    expect(exited(child(null, null))).toBe(false);
    expect(exited(child(0, null))).toBe(true);
    expect(exited(child(null, "SIGTERM"))).toBe(true);
  });

  it("packaged-smoke 的数据根先过沙箱闸，剪贴板只在仍是本轮标记时还原", () => {
    const source = readFileSync("scripts/packaged-smoke.ts", "utf8");
    expect(source).toMatch(
      /const dataDir = assertSandboxDataDir\(\s*process\.env\.ATM_SMOKE_DATA_DIR \?\? join\(outputDir, "packaged-smoke-data"\),?\s*\);/u,
    );
    expect(source).toMatch(
      /if \(Buffer\.from\(current, "base64"\)\.toString\("utf8"\) === marker\) \{\s*if \(snapshot === "EMPTY"\)/u,
    );
  });
});
