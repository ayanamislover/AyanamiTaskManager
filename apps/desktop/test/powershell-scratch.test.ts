import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("凡是用 Add-Type 编译 C# 的脚本都走这个临时根", () => {
    const scripts = join(process.cwd(), "scripts");
    const compiling = readdirSync(scripts)
      .filter((name) => /\.(?:ts|ps1)$/u.test(name))
      .filter((name) =>
        /Add-Type\s+(?:@"|-Namespace|-TypeDefinition)/u.test(
          readFileSync(join(scripts, name), "utf8"),
        ),
      );
    expect(compiling.length).toBeGreaterThan(3);
    for (const name of compiling) {
      // .ps1 由 native-window.ts 拉起，检查拉起它的那一边。
      const launcher = name.endsWith(".ps1") ? name.replace(/\.ps1$/u, ".ts") : name;
      expect(readFileSync(join(scripts, launcher), "utf8"), launcher).toMatch(
        /powershellScratch\(|withPowerShellScratch\(/u,
      );
    }
  });
});
