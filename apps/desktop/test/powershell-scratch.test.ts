import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { NativeWindowProbe } from "../../../scripts/native-window.js";
import {
  POWERSHELL_SCRATCH_PREFIX,
  powershellScratch,
  withPowerShellScratch,
} from "../../../scripts/powershell-scratch.js";

const outputRoot = join(process.cwd(), "output");
const scratchDirectories = () =>
  existsSync(outputRoot)
    ? readdirSync(outputRoot).filter((name) => name.startsWith(POWERSHELL_SCRATCH_PREFIX))
    : [];
/** .NET 编译 Add-Type 时在 %TEMP% 下建的随机 8 字符目录。 */
const compilerDirectories = () =>
  readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9]{8}$/u.test(entry.name))
    .map((entry) => entry.name);

// Add-Type 编译 C# 每次都在 %TEMP% 留一个空目录；烟测和探针的 PowerShell 一律改到 output/ 下的
// 临时根，用完删掉（全局规则：不许往 %TEMP% 里堆）。
describe("PowerShell 的编译临时目录不落 %TEMP%", () => {
  it("临时根在 output/ 下，TEMP 与 TMP 都指向它，用完（含异步）删掉", async () => {
    const scratch = powershellScratch();
    expect(scratch.env.TEMP).toBe(scratch.env.TMP);
    expect(scratch.env.TEMP!.startsWith(join(outputRoot, POWERSHELL_SCRATCH_PREFIX))).toBe(true);
    expect(existsSync(scratch.env.TEMP!)).toBe(true);
    scratch.dispose();
    scratch.dispose();
    expect(existsSync(scratch.env.TEMP!)).toBe(false);

    let seen = "";
    await withPowerShellScratch(async (env) => {
      seen = env.TEMP!;
      expect(existsSync(seen)).toBe(true);
    });
    expect(existsSync(seen)).toBe(false);
    expect(() =>
      withPowerShellScratch((env) => {
        seen = env.TEMP!;
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(seen)).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "真起一次原生窗口探针：%TEMP% 不多目录，探针退出后临时根也删了",
    async () => {
      const before = new Set(compilerDirectories());
      const scratchBefore = new Set(scratchDirectories());
      const probe = NativeWindowProbe.start();
      await probe.windows(process.pid);
      probe.close();
      const deadline = Date.now() + 10_000;
      while (scratchDirectories().some((name) => !scratchBefore.has(name)) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
      expect(scratchDirectories().filter((name) => !scratchBefore.has(name))).toEqual([]);
      expect(compilerDirectories().filter((name) => !before.has(name))).toEqual([]);
    },
    60_000,
  );

  // 被扫描、编译进程还没走时删不掉：不抛、不当成已删，之后能再删。
  it("删不掉时不抛、不当成已删，解除占用后再删就成功", () => {
    let attempts = 0;
    const scratch = powershellScratch(process.cwd(), process.env, (directory) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      rmSync(directory, { recursive: true, force: true });
    });
    expect(scratch.dispose()).toBe(false);
    expect(existsSync(scratch.env.TEMP!)).toBe(true);
    expect(scratch.dispose()).toBe(true);
    expect(existsSync(scratch.env.TEMP!)).toBe(false);
    expect(scratch.dispose()).toBe(true);
    expect(attempts).toBe(2);
    // 一次性调用里清理失败不盖住 run 自己的错误。
    expect(() =>
      withPowerShellScratch(() => {
        throw new Error("run failed");
      }),
    ).toThrow("run failed");
  });

  it.runIf(process.platform === "win32")(
    "驱动忘了 close 还崩了：探针与临时根照样被带走，%TEMP% 不多目录",
    () => {
      const before = new Set(compilerDirectories());
      const scratchBefore = new Set(scratchDirectories());
      const loader = pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href;
      const result = spawnSync(
        process.execPath,
        ["--import", loader, "apps/desktop/test/fixtures/probe-forgotten.mts", process.cwd()],
        { encoding: "utf8", timeout: 60_000, windowsHide: true },
      );
      expect(result.stdout).toContain("probe-ready");
      expect(result.status).not.toBe(0);
      expect(scratchDirectories().filter((name) => !scratchBefore.has(name))).toEqual([]);
      expect(compilerDirectories().filter((name) => !before.has(name))).toEqual([]);
    },
    90_000,
  );

  it("凡是用 Add-Type 编译 C# 的脚本都走这个临时根（递归、大小写不敏感，注释里提到不算）", () => {
    const scripts = join(process.cwd(), "scripts");
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:ts|mts|ps1)$/iu.test(name)) files.push(path);
      }
    };
    walk(scripts);
    const compiles =
      /add-type\s+(?:@["']|-typedefinition\b|-namespace\b|-memberdefinition\b|-name\s)/iu;
    const usesScratch = (source: string) =>
      source
        .split(/\r?\n/u)
        .some(
          (line) =>
            !/^\s*(?:\/\/|\*)/u.test(line) &&
            /\b(?:powershellScratch|withPowerShellScratch)\(/u.test(line),
        );
    const compiling = files.filter((path) => compiles.test(readFileSync(path, "utf8")));
    expect(compiling.length).toBeGreaterThan(4);
    for (const path of compiling) {
      // .ps1 由同名 .ts 拉起，检查拉起它的那一边。
      const launcher = path.replace(/\.ps1$/iu, ".ts");
      expect(usesScratch(readFileSync(launcher, "utf8")), relative(scripts, launcher)).toBe(true);
    }
    // 阳性对照：守卫自己认得出这些写法，也不被注释骗过。
    for (const sample of [
      "Add-Type @'",
      "ADD-TYPE -TypeDefinition $x",
      "add-type -MemberDefinition 'x' -Name N",
    ])
      expect(compiles.test(sample), sample).toBe(true);
    expect(usesScratch("// withPowerShellScratch(() => 1)")).toBe(false);
    expect(usesScratch("  return withPowerShellScratch((env) => run(env));")).toBe(true);
  });
});
