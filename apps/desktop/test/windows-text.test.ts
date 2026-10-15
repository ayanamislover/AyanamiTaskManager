import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseRegistryJson,
  powershellArgs,
  powershellText,
  readShortcut,
  registryValues,
  scheduledTaskXml,
  UTF8_OUTPUT,
  writeShortcut,
} from "../../../scripts/windows-text.js";

// W8 关口 peer r16 P2-01：Windows PowerShell 5.1、reg.exe、schtasks.exe 的输出按系统代码页编码，按 UTF-8
// 解码时代码页之外的字符成了替换字符；路径比较、「没有残留进程」会空转。本机是中文系统，只有英文 CI 才红。
// scripts/ 里 PowerShell 的 -Command 一律经 powershellArgs（先设 UTF-8 输出），注册表与计划任务经
// windows-text.ts 读，不解析 reg.exe / schtasks.exe 的输出。
const scriptsDir = join(process.cwd(), "scripts");

/** 一份脚本里绕开 windows-text.ts 的地方。 */
function problems(source: string): string[] {
  const found: string[] = [];
  if (/"-Command"/u.test(source)) found.push("PowerShell -Command not through powershellArgs");
  if (/"reg(?:\.exe)?",\s*\[\s*"query"/iu.test(source) || /\breg\(\[\s*"query"/u.test(source))
    found.push("reg.exe query output parsed");
  if (/"schtasks(?:\.exe)?",\s*\[\s*"\/query"/iu.test(source))
    found.push("schtasks.exe output parsed");
  return found;
}

describe("脚本读 Windows 的文字一律走 Unicode", () => {
  it("scripts/ 里只有 windows-text.ts 自己拼 -Command；不解析 reg.exe、schtasks.exe 的输出", () => {
    const files = readdirSync(scriptsDir).filter(
      (name) => name.endsWith(".ts") && name !== "windows-text.ts",
    );
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap((name) =>
      problems(readFileSync(join(scriptsDir, name), "utf8")).map((p) => `${name}: ${p}`),
    );
    expect(found).toEqual([]);
    const args = powershellArgs("Write-Output 1", ["-STA"]);
    expect(args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
      `${UTF8_OUTPUT}Write-Output 1`,
    ]);
    expect(UTF8_OUTPUT).toBe("[Console]::OutputEncoding = [Text.Encoding]::UTF8; ");
    // 计划任务只读：经 Schedule.Service 的 GetTask，不登记、不删除、不经 WMI（ScheduledTasks 模块）。
    const text = readFileSync(join(scriptsDir, "windows-text.ts"), "utf8");
    expect(text).toContain(".GetTask($env:ATM_TEXT_TASK)");
    expect(text).not.toMatch(/RegisterTask|DeleteTask|Get-ScheduledTask|Export-ScheduledTask/u);
  });

  it("阳性对照：原来的写法都认得出", () => {
    expect(
      problems(
        'spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);',
      ),
    ).toEqual(["PowerShell -Command not through powershellArgs"]);
    expect(problems('execFileSync("reg.exe", ["query", RUN_KEY], { encoding: "utf8" })')).toEqual([
      "reg.exe query output parsed",
    ]);
    expect(problems('const result = reg(["query", key, "/v", name]);')).toEqual([
      "reg.exe query output parsed",
    ]);
    expect(
      problems('spawnSync("schtasks.exe", ["/query", "/tn", KEEPALIVE_TASK, "/xml"])'),
    ).toEqual(["schtasks.exe output parsed"]);
    expect(problems('reg(["add", key, "/v", name, "/d", value, "/f"]);')).toEqual([]);
  });

  it("注册表的类型名换成 reg.exe 的写法", () => {
    expect(
      parseRegistryJson(
        JSON.stringify({
          a: { type: "String", data: "x" },
          b: { type: "ExpandString", data: "%LOCALAPPDATA%" },
          c: { type: "DWord", data: "0xa" },
          d: { type: "Unknown", data: "" },
        }),
      ),
    ).toEqual({
      a: { type: "REG_SZ", data: "x" },
      b: { type: "REG_EXPAND_SZ", data: "%LOCALAPPDATA%" },
      c: { type: "REG_DWORD", data: "0xa" },
      d: { type: "REG_NONE", data: "" },
    });
    expect(parseRegistryJson("")).toEqual({});
  });

  // 动态：系统代码页（936 或 1252）都表示不了的字符原样往返。
  const unicode = "ő Ω 😀 中文";
  it.runIf(process.platform === "win32")(
    "代码页之外的字符经 PowerShell、快捷方式原样往返；不存在的键与任务是 null",
    () => {
      const echo = powershellText("[Console]::Out.Write($env:ATM_TEXT_ECHO)", {
        vars: { ATM_TEXT_ECHO: unicode },
      });
      expect(echo.stdout).toBe(unicode);

      mkdirSync(join(process.cwd(), "output"), { recursive: true });
      const base = mkdtempSync(join(process.cwd(), "output", "windows-text-test-"));
      try {
        const dir = join(base, unicode);
        mkdirSync(dir, { recursive: true });
        const lnk = join(dir, "ATM 修复.lnk");
        const fields = { target: join(dir, "ő.exe"), args: `--repair ${unicode}`, workdir: dir };
        writeShortcut(lnk, fields);
        expect(readShortcut(lnk)).toEqual(fields);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }

      expect(registryValues("HKCU\\Software\\AtmWindowsTextTestNoSuchKey")).toBeNull();
      expect(scheduledTaskXml("AtmWindowsTextTestNoSuchTask")).toBeNull();
    },
    120_000,
  );
});
