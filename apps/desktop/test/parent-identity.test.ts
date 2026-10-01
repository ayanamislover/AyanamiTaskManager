import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  isTrustedHostParent,
  parseHelperIdentity,
  parseParentIdentity,
  queryParentIdentity,
} from "../src/parent-identity.js";

/**
 * de-electron §9 负例「普通进程直接起 core（父进程非宿主）→ 拒绝」的单元层（ATM-T-0520）。
 * 真实进程层见 core-process.test.ts「不是宿主的进程直接拉起 core」；这里把判定本身逐条钉住：
 * 父进程查不到、映像不是本版本目录里的宿主、PID 被复用（父进程比 core 晚启动）都必须拒绝。
 */
const scratchRoot = resolve(process.cwd(), "output");
mkdirSync(scratchRoot, { recursive: true });
const work = mkdtempSync(join(scratchRoot, "parent-identity-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const appDir = join(work, "app-2.0.0");
mkdirSync(appDir, { recursive: true });
const hostPath = join(appDir, "AyanamiTaskManager.exe");
writeFileSync(hostPath, "");
const selfStartedAtMs = 1_800_000_000_000;

describe("core 的父进程校验", () => {
  it("查不到父进程（拒绝访问、超时、已退出）一律拒绝", () => {
    expect(isTrustedHostParent(null, hostPath, selfStartedAtMs)).toBe(false);
  });

  it("父进程映像必须就是本版本目录里的宿主；大小写与结尾分隔符不影响判定", () => {
    const parent = { path: hostPath.toUpperCase(), startedAtMs: selfStartedAtMs - 1_000 };
    expect(isTrustedHostParent(parent, hostPath, selfStartedAtMs)).toBe(true);
    expect(
      isTrustedHostParent({ ...parent, path: `${hostPath}\\` }, hostPath, selfStartedAtMs),
    ).toBe(true);
    for (const path of [
      // 任意同用户进程：node、PowerShell、别的版本目录里的宿主、同目录下改了名的 exe。
      process.execPath,
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      join(work, "app-1.9.9", "AyanamiTaskManager.exe"),
      join(appDir, "AyanamiTaskManager.exe.bak"),
      join(appDir, "runtime", "atm-core.exe"),
      `${hostPath}:evil`,
      "",
    ])
      expect(isTrustedHostParent({ ...parent, path }, hostPath, selfStartedAtMs), path).toBe(false);
  });

  it("父进程比 core 晚启动 = PID 被复用：即便映像对得上也拒绝", () => {
    const reused = { path: hostPath, startedAtMs: selfStartedAtMs + 1 };
    expect(isTrustedHostParent(reused, hostPath, selfStartedAtMs)).toBe(false);
    expect(
      isTrustedHostParent({ ...reused, startedAtMs: selfStartedAtMs }, hostPath, selfStartedAtMs),
    ).toBe(true);
  });

  it("经 current junction 启动的宿主报告链接路径：解析到真实路径后照样认", () => {
    const current = join(work, "current");
    symlinkSync(appDir, current, "junction");
    const parent = {
      path: join(current, "AyanamiTaskManager.exe"),
      startedAtMs: selfStartedAtMs - 1,
    };
    expect(isTrustedHostParent(parent, hostPath, selfStartedAtMs)).toBe(true);
    // junction 不能反过来把别处的同名 exe 接成可信宿主。
    const elsewhere = join(work, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "AyanamiTaskManager.exe"), "");
    const link = join(work, "link-elsewhere");
    symlinkSync(elsewhere, link, "junction");
    expect(
      isTrustedHostParent(
        { ...parent, path: join(link, "AyanamiTaskManager.exe") },
        hostPath,
        selfStartedAtMs,
      ),
    ).toBe(false);
  });

  it("PowerShell 输出只认「路径 + 毫秒时间戳」两行，其余一律当查不到", () => {
    expect(parseParentIdentity(`${hostPath}\r\n1700000000000\r\n`)).toEqual({
      path: hostPath,
      startedAtMs: 1_700_000_000_000,
    });
    for (const bad of [
      "",
      hostPath,
      `${hostPath}\nnot-a-number`,
      `${hostPath}\n-1`,
      `${hostPath}\n0`,
      `${hostPath}\n1.5`,
      `${hostPath}\n99999999999999999`,
      `${"x".repeat(1025)}\n1700000000000`,
    ])
      expect(parseParentIdentity(bad), JSON.stringify(bad)).toBeNull();
  });

  it("非法 PID 不起查询直接当查不到；真实 PID 查到的是那个进程的映像", async () => {
    for (const pid of [0, -1, Number.NaN, 1.5]) expect(await queryParentIdentity(pid)).toBeNull();
    const self = await queryParentIdentity(process.pid);
    expect(self).not.toBeNull();
    expect(isTrustedHostParent(self, process.execPath, Date.now())).toBe(true);
    expect(isTrustedHostParent(self, hostPath, Date.now())).toBe(false);
  }, 20_000);

  // 宿主 --process-identity 的三行输出：ticks、Unix 毫秒、映像路径。
  it("宿主查询的输出：三行齐全才算，ticks 与毫秒都要合法", () => {
    const lines = (...values: string[]) => values.join("\n");
    expect(
      parseHelperIdentity(`${lines("639264096000000000", "1790812800000", hostPath)}\n`),
    ).toEqual({ path: hostPath, startedAtMs: 1790812800000 });
    for (const bad of [
      "",
      lines("639264096000000000", "1790812800000"),
      lines("x", "1790812800000", hostPath),
      lines("639264096000000000", "nope", hostPath),
      lines("639264096000000000", "0", hostPath),
    ])
      expect(parseHelperIdentity(bad), JSON.stringify(bad)).toBeNull();
  });

  it("宿主给不出答案就退回 PowerShell：答案一样，进程不存在仍是查不到", async () => {
    const direct = await queryParentIdentity(process.pid);
    expect(isTrustedHostParent(direct, process.execPath, Date.now())).toBe(true);
    // 宿主不在、或起来了却不认这个参数（node.exe）。
    expect(await queryParentIdentity(process.pid, join(work, "no-such-host.exe"))).toEqual(direct);
    expect(await queryParentIdentity(process.pid, process.execPath)).toEqual(direct);
    expect(await queryParentIdentity(0x7ffffff0, process.execPath)).toBeNull();
  }, 30_000);

  // 冷启动不再等 PowerShell：core 两次身份查询都交给本版本目录里的宿主。
  it("core 把本版本目录里的宿主交给两次身份查询", () => {
    const core = readFileSync("apps/desktop/src/core-main.ts", "utf8");
    expect(core).toContain("configureProcessIdentityHelper(paths.hostPath);");
    expect(core).toContain("queryParentIdentity(process.ppid, paths.hostPath)");
    expect(core.indexOf("configureProcessIdentityHelper(paths.hostPath);")).toBeLessThan(
      core.indexOf("void prefetchSelfProcessIdentity();"),
    );
  });
});
