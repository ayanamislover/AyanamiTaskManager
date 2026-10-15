import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// W8 关口第三次在 CI 上：install-drill 用 WScript.Shell 读 `ATM 修复.lnk`，英文系统（代码页 1252）上
// 读回空的——它的快捷方式对象受 ANSI 代码页限制，中文系统上恰好读得出，所以本机一直是绿的。
// 读快捷方式一律经 Shell.Application；还用 WScript.Shell 的地方（建快捷方式）路径只经环境变量传，
// 不拼进脚本文本。
const scriptsDir = join(process.cwd(), "scripts");

/** 一份脚本里违反上面两条的地方。 */
function problems(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/WScript\.Shell\)\.CreateShortcut\(([^)]*)\)/gu)) {
    if (!m[1]!.trim().startsWith("$env:")) found.push(`path spliced into the script: ${m[0]}`);
  }
  if (
    /CreateShortcut\([^)]*\)[^\n]*\.(Arguments|TargetPath|WorkingDirectory)\s*[;}\]]/u.test(source)
  ) {
    found.push("a shortcut is read through WScript.Shell");
  }
  return found;
}

describe("读快捷方式不受系统代码页限制", () => {
  it("scripts/ 里没有经 WScript.Shell 读快捷方式，也没有把路径拼进 CreateShortcut", () => {
    const files = readdirSync(scriptsDir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap((name) =>
      problems(readFileSync(join(scriptsDir, name), "utf8")).map((p) => `${name}: ${p}`),
    );
    expect(found).toEqual([]);
    expect(readFileSync(join(scriptsDir, "install-drill.ts"), "utf8")).toContain(
      "New-Object -ComObject Shell.Application",
    );
  });

  it("阳性对照：原来的写法两条都认得出", () => {
    const before =
      "const script = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${literal}'); " +
      "[pscustomobject]@{ target = $s.TargetPath; args = $s.Arguments; workdir = $s.WorkingDirectory } | ConvertTo-Json`;";
    expect(problems(before)).toEqual([
      "path spliced into the script: WScript.Shell).CreateShortcut('${literal}')",
      "a shortcut is read through WScript.Shell",
    ]);
    expect(
      problems(
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:ATM_DRILL_SHORTCUT); $s.Save()",
      ),
    ).toEqual([]);
  });
});
