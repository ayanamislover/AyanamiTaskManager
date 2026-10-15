import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// W8 关口第三次在 CI 上：install-drill 用 WScript.Shell 读 `ATM 修复.lnk`，英文系统（代码页 1252）上
// 读回空的——它的快捷方式对象受 ANSI 代码页限制，中文系统上恰好读得出，所以本机一直是绿的。
// peer r16 P2-01：建快捷方式也一样，名字是 ASCII，上级目录却来自仓库根，未必在 ANSI 代码页里。
// 所以 scripts/ 里不再用 WScript.Shell：读经 Shell.Application，写经 IShellLinkW（都在 windows-text.ts）。
const scriptsDir = join(process.cwd(), "scripts");

/** 一份脚本里违反上面这条的地方。 */
function problems(source: string): string[] {
  return [...source.matchAll(/ComObject\s+WScript\.Shell/giu)].map(
    (m) => `WScript.Shell COM object: ${m[0]}`,
  );
}

describe("快捷方式的读写不受系统代码页限制", () => {
  it("scripts/ 里没有 WScript.Shell；读经 Shell.Application，写经 IShellLinkW", () => {
    const files = readdirSync(scriptsDir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap((name) =>
      problems(readFileSync(join(scriptsDir, name), "utf8")).map((p) => `${name}: ${p}`),
    );
    expect(found).toEqual([]);
    const text = readFileSync(join(scriptsDir, "windows-text.ts"), "utf8");
    expect(text).toContain("New-Object -ComObject Shell.Application");
    expect(text).toContain('Guid("000214F9-0000-0000-C000-000000000046")');
    expect(text).toContain("[MarshalAs(UnmanagedType.LPWStr)] string file);\n}");
    const drill = readFileSync(join(scriptsDir, "install-drill.ts"), "utf8");
    expect(drill).toContain("readShortcut(path)");
    expect(drill).toContain('writeShortcut(join(dir, "AyanamiTaskManager.lnk"), {');
  });

  it("阳性对照：原来的写法认得出", () => {
    const before =
      "const script = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:ATM_DRILL_SHORTCUT); " +
      "[pscustomobject]@{ target = $s.TargetPath } | ConvertTo-Json`;";
    expect(problems(before)).toEqual(["WScript.Shell COM object: ComObject WScript.Shell"]);
    expect(problems("// IShellLinkW, not WScript.Shell: the file name is ASCII")).toEqual([]);
  });
});
