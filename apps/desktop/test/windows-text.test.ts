import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseRegistryJson,
  powershellArgs,
  powershellText,
  readShortcut,
  REGISTRY_FUNCTIONS,
  REGISTRY_MAIN,
  registryReply,
  registryValues,
  scheduledTaskXml,
  TASK_FUNCTIONS,
  TASK_MAIN,
  taskReply,
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
    expect(text).toContain(".GetTask($name)");
    expect(text).toContain("Read-AtmTaskXml $env:ATM_TEXT_TASK");
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
    expect(parseRegistryJson("{}")).toEqual({});
    // peer r17 P1-02：空输出、不是对象、值的形状不对都不算读到——半份快照会让还原删掉用户原来的值。
    for (const bad of ["", "[]", "null", '{"a":{"type":"String","data":{}}}', '{"a":"x"}'])
      expect(() => parseRegistryJson(bad), bad).toThrow();
  });

  // 两层各自守住（脚本主体以 2 退出，TS 一侧也拒绝不完整的回复），一层被改坏另一层不会替它遮住。
  it("TS 一侧拒绝不完整的回复", () => {
    const reply = (status: number, stdout: string) => ({
      pid: 0,
      output: [],
      stdout,
      stderr: "",
      status,
      signal: null,
    });
    expect(() => registryReply(reply(0, ""), "synthetic")).toThrow();
    expect(() => registryReply(reply(2, ""), "synthetic")).toThrow();
    expect(registryReply(reply(3, ""), "synthetic")).toBeNull();
    expect(() => taskReply(reply(0, ""), "synthetic")).toThrow();
    expect(() => taskReply(reply(0, "not xml"), "synthetic")).toThrow();
    expect(() => taskReply(reply(2, ""), "synthetic")).toThrow();
    expect(taskReply(reply(3, ""), "synthetic")).toBeNull();
  });

  // peer r17 P1-02、P2-01、P2-03：换掉读注册表 / 读任务的函数，造出读失败、转换失败，看主体怎么收场。
  // 不碰真实注册表与计划任务。
  const FAKE_KEY = `
function New-AtmFakeKey($values, $kinds, [switch]$failRead) {
  $k = [pscustomobject]@{ Values = $values; Kinds = $kinds; Fail = [bool]$failRead }
  $k | Add-Member ScriptMethod GetValueNames { @($this.Values.Keys) }
  $k | Add-Member ScriptMethod GetValueKind { param($n) $this.Kinds[$n] }
  $k | Add-Member ScriptMethod GetValue { param($n, $d, $o) if ($this.Fail) { throw 'synthetic read failure' }; ,$this.Values[$n] }
  return $k
}
`;
  const registryWith = (override: string) =>
    registryReply(
      powershellText(`${REGISTRY_FUNCTIONS}${FAKE_KEY}${override}\n${REGISTRY_MAIN}`),
      "synthetic",
    );
  const taskWith = (override: string) =>
    taskReply(powershellText(`${TASK_FUNCTIONS}\n${override}\n${TASK_MAIN}`), "synthetic");

  it.runIf(process.platform === "win32")(
    "读失败一律抛出、不出半份快照；值按 reg.exe 的写法保真；只有确定的不在是 null",
    () => {
      // 打不开（拒绝访问之类）、读值失败、转换失败：抛出，不是「不在」也不是空快照。
      expect(() =>
        registryWith("function Open-AtmKey($key) { throw 'synthetic access denied' }"),
      ).toThrow(/synthetic access denied/u);
      expect(() =>
        registryWith(
          "function Open-AtmKey($key) { New-AtmFakeKey @{ a = 'x' } @{ a = 'String' } -failRead }",
        ),
      ).toThrow(/synthetic read failure/u);
      expect(() =>
        registryWith(
          "function Open-AtmKey($key) { New-AtmFakeKey @{ a = 'x'; b = 'y' } @{ a = 'String'; b = 'String' } }; " +
            "function Convert-AtmValue($kind, $v) { if ($v -eq 'y') { throw 'synthetic conversion failure' }; [string]$v }",
        ),
      ).toThrow(/synthetic conversion failure/u);
      // 脚本主体自己：失败以 2 退出，stdout 什么都没有。
      const denied = powershellText(
        `${REGISTRY_FUNCTIONS}function Open-AtmKey($key) { throw 'synthetic access denied' }\n${REGISTRY_MAIN}`,
      );
      expect([denied.status, denied.stdout]).toEqual([2, ""]);
      // 确定不在：null。
      expect(registryWith("function Open-AtmKey($key) { $null }")).toBeNull();
      // 高位整数按位、REG_NONE 与二进制是十六进制、多字符串用 \0、默认值（空名字）照样在。
      expect(
        registryWith(
          "function Open-AtmKey($key) { New-AtmFakeKey " +
            "@{ dword = [int32]-1; ten = [int32]10; qword = [int64]-1; none = [byte[]](0, 255, 128); bin = [byte[]](1); multi = [string[]]('a', 'b'); expand = '%X%'; '' = 'default' } " +
            "@{ dword = 'DWord'; ten = 'DWord'; qword = 'QWord'; none = 'None'; bin = 'Binary'; multi = 'MultiString'; expand = 'ExpandString'; '' = 'String' } }",
        ),
      ).toEqual({
        dword: { type: "REG_DWORD", data: "0xffffffff" },
        ten: { type: "REG_DWORD", data: "0xa" },
        qword: { type: "REG_QWORD", data: "0xffffffffffffffff" },
        none: { type: "REG_NONE", data: "00FF80" },
        bin: { type: "REG_BINARY", data: "01" },
        multi: { type: "REG_MULTI_SZ", data: "a\\0b" },
        expand: { type: "REG_EXPAND_SZ", data: "%X%" },
        "": { type: "REG_SZ", data: "default" },
      });

      // 任务：读 Xml 失败、读出空的或不是任务 XML 都抛出；只有确定没有登记是 null。
      expect(() =>
        taskWith("function Read-AtmTaskXml($name) { throw 'synthetic Xml getter failure' }"),
      ).toThrow(/synthetic Xml getter failure/u);
      expect(() => taskWith("function Read-AtmTaskXml($name) { '' }")).toThrow();
      expect(() => taskWith("function Read-AtmTaskXml($name) { 'not xml' }")).toThrow();
      const notXml = powershellText(
        `${TASK_FUNCTIONS}\nfunction Read-AtmTaskXml($name) { 'not xml' }\n${TASK_MAIN}`,
      );
      expect([notXml.status, notXml.stdout]).toEqual([2, ""]);
      expect(taskWith("function Read-AtmTaskXml($name) { $null }")).toBeNull();
      expect(
        taskWith("function Read-AtmTaskXml($name) { '<?xml version=\"1.0\"?><Task></Task>' }"),
      ).toBe('<?xml version="1.0"?><Task></Task>');
    },
    120_000,
  );

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
