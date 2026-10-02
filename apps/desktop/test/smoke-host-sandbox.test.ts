import type { ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  // CI 上 LOCALAPPDATA 是 8.3 短名（C:\Users\RUNNER~1\…），junction 解出来却是长名；
  // 这里用 junction 别名造出同样「真实根写法不规范」的情形。
  it("真实根写成别名时，经 junction 接过去的数据根仍按真实数据根拒绝", () => {
    const { output, real, options } = layout();
    const alias = join(scratch!, "LocalAlias");
    symlinkSync(join(scratch!, "Local"), alias, "junction");
    symlinkSync(real, join(output, "linked"), "junction");
    const realRoots = options.realRoots.map((root) => join(alias, root.split(/[\\/]/u).pop()!));
    expect(() =>
      assertSandboxDataDir(join(output, "linked", "data"), { outputRoot: output, realRoots }),
    ).toThrow(/真实数据根/u);
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
      // 经 junction 别名进来：字面父目录没有安装，真实父目录有，也要拒。
      mkdirSync(join(scratch, "alias"));
      symlinkSync(
        join(scratch, "installed", "app-9.9.9"),
        join(scratch, "alias", "app-9.9.9"),
        "junction",
      );
      process.env.ATM_PACKAGED_EXE = join(scratch, "alias", "app-9.9.9", "AyanamiTaskManager.exe");
      expect(() => smokeExecutable()).toThrow(/不能放在一份安装里/u);
      const smoke = host("smoke", "MZ --remote-debugging-port=0");
      process.env.ATM_PACKAGED_EXE = smoke;
      expect(smokeExecutable()).toBe(realpathSync.native(smoke));
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

  // 先启动宿主、后拍 Run 快照的话，快照读失败时宿主已经起来了却没人收拾（Codex R5-P2-3）。
  it("每个直接启动烟测宿主的脚本都先拍 Run 快照", () => {
    const scripts = join(process.cwd(), "scripts");
    const starting = readdirSync(scripts)
      .filter((name) => name.endsWith(".ts") && name !== "smoke-host.ts")
      .filter((name) => readFileSync(join(scripts, name), "utf8").includes("startSmokeHost("));
    expect(starting.length).toBeGreaterThanOrEqual(6);
    for (const name of starting) {
      const source = readFileSync(join(scripts, name), "utf8");
      const snapshot = source.indexOf("snapshotLoginItems(");
      expect(snapshot, name).toBeGreaterThan(0);
      expect(snapshot, name).toBeLessThan(source.indexOf("startSmokeHost("));
      // 探针也是资源：快照读不到时它还没起来，就没有要收拾的。
      const probe = source.indexOf("NativeWindowProbe.start(");
      if (probe >= 0) expect(snapshot, name).toBeLessThan(probe);
      expect(source, name).not.toContain("withLoginItemsRestored(");
    }
  });

  // 收尾按 PID 结束进程前先核出生身份（PID 可能已被系统复用给无关进程，Codex R5/R6-P2-4）：
  // 出生时间与树成员身份一起取；核对与结束在同一个进程句柄上；查不了的不当成已退出。
  it("预算脚本只结束 PID 上仍是当初那个进程的，查不了的如实报告", () => {
    const budget = readFileSync("scripts/budget-measure.ts", "utf8");
    // 探针的 C# 在 budget-probe.ts（真编译的行为见 budget-probe.test.ts）。
    const probe = readFileSync("scripts/budget-probe.ts", "utf8");
    expect(probe).toContain("process.StartTime.ToUniversalTime().Ticks");
    expect(probe).toMatch(
      /IntPtr pinned = process\.Handle;\s*if \(process\.StartTime\.ToUniversalTime\(\)\.Ticks != ticks\) return "other";\s*process\.Kill\(\);/u,
    );
    expect(budget).toContain("for (const row of descendants) await probe.killSame(row);");
    expect(budget).toContain("states.every((state) => EXITED_STATES.has(state))");
    expect(budget).not.toMatch(/killProcessTree\(row\.pid\)/u);
    expect(budget).not.toMatch(/process\.kill\(pid, 0\)/u);
    expect(budget).not.toMatch(/child\.exitCode/u);
  });
});
