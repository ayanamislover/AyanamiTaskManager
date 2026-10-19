import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseRegistryJson,
  powershellArgs,
  powershellText,
  readShortcut,
  REGISTRY_MAIN,
  REGISTRY_SET_MAIN,
  REGISTRY_SOURCE,
  registryPrelude,
  registryReply,
  registryValues,
  registryWriteReply,
  registryWriteVars,
  scheduledTaskXml,
  TASK_FUNCTIONS,
  TASK_MAIN,
  taskReply,
  UTF8_OUTPUT,
  writeShortcut,
} from "../../../scripts/windows-text.js";
import { withPowerShellScratch } from "../../../scripts/powershell-scratch.js";

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
    // 注册表经 advapi32：.NET 的 OpenSubKey、GetValue 会把部分失败吞成 null / 默认值（peer r18 P1-01）。
    expect(REGISTRY_SOURCE).not.toMatch(/Microsoft\.Win32|OpenSubKey|GetValue\(/u);
    expect(text).not.toMatch(/\[Microsoft\.Win32\.Registry\]|Test-Path -LiteralPath .Registry::/u);
    expect(REGISTRY_SOURCE).not.toContain(String.fromCharCode(92));
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

  it("注册表 JSON 的形状不对一律抛出", () => {
    const value = { type: "REG_SZ", code: 1, data: "x", raw: "780000" };
    expect(parseRegistryJson(JSON.stringify({ a: value }))).toEqual({ a: value });
    expect(parseRegistryJson("{}")).toEqual({});
    // peer r17 P1-02：空输出、不是对象、值的形状不对都不算读到——半份快照会让还原删掉用户原来的值。
    // peer r18 P2-01：还原要用的 code 与 raw 缺了、raw 不是十六进制，也不算。
    const broken = [
      "",
      "[]",
      "null",
      '{"a":"x"}',
      JSON.stringify({ a: { ...value, data: {} } }),
      JSON.stringify({ a: { type: "REG_SZ", data: "x" } }),
      JSON.stringify({ a: { ...value, code: -1 } }),
      JSON.stringify({ a: { ...value, code: 1.5 } }),
      JSON.stringify({ a: { ...value, raw: "78000" } }),
      JSON.stringify({ a: { ...value, raw: "zz" } }),
      JSON.stringify({ a: { ...value, raw: "7800ab" } }),
    ];
    for (const bad of broken) expect(() => parseRegistryJson(bad), bad).toThrow();
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
    expect(() => registryWriteReply(reply(0, ""), "synthetic")).toThrow();
    expect(() => registryWriteReply(reply(2, ""), "synthetic")).toThrow();
    expect(() => registryWriteReply(reply(2, "ok"), "synthetic")).toThrow();
    expect(() => registryWriteReply(reply(0, "ok"), "synthetic")).not.toThrow();
    expect(() => taskReply(reply(0, ""), "synthetic")).toThrow();
    expect(() => taskReply(reply(0, "not xml"), "synthetic")).toThrow();
    expect(() => taskReply(reply(2, ""), "synthetic")).toThrow();
    expect(taskReply(reply(3, ""), "synthetic")).toBeNull();
  });

  // peer r18 P1-01：注册表经 advapi32 读写，每个返回码都留着。用例把系统调用（AtmRegApi）换成假的实现，
  // 造出各种返回码与「读的过程中变了」，走的仍是 REGISTRY_SOURCE 里的判断与 REGISTRY_MAIN 的主体。
  // 不碰真实注册表。
  const FAKE_API = `
public sealed class AtmFakeApi : AtmRegApi {
  public int OpenStatus, QueryStatus, CreateStatus, SetStatus, DeleteStatus;
  public int EnumFailAt = -1, EnumFailStatus;
  public int GrowReads, ShortReads, ChangeReads, FlipReads;
  public List<string> Names = new List<string>();
  public List<int> Types = new List<int>();
  public List<byte[]> Datas = new List<byte[]>();
  public StringBuilder Log = new StringBuilder();
  int reads;
  public void Add(string name, int type, byte[] data) { Names.Add(name); Types.Add(type); Datas.Add(data); }
  public void AddText(string name, int type, string text) { Add(name, type, Encoding.Unicode.GetBytes(text)); }
  public override int Open(UIntPtr root, string sub, int access, out IntPtr key) { key = new IntPtr(7); Log.Append("open " + root.ToUInt64().ToString("x") + " " + sub + " " + access.ToString("x") + ";"); return OpenStatus; }
  public override int Create(UIntPtr root, string sub, int access, out IntPtr key) { key = new IntPtr(7); Log.Append("create " + sub + ";"); return CreateStatus; }
  public override int QueryInfo(IntPtr key, out int values, out int maxName, out int maxData) {
    reads++;
    values = Names.Count; maxName = 0; maxData = 0;
    foreach (string n in Names) maxName = Math.Max(maxName, n.Length);
    foreach (byte[] d in Datas) maxData = Math.Max(maxData, d.Length);
    if (reads <= GrowReads) maxData = 0;
    return QueryStatus;
  }
  public override int EnumValue(IntPtr key, int index, StringBuilder name, ref int nameLength, out int type, byte[] data, ref int dataLength) {
    type = 0;
    if (index == EnumFailAt) return EnumFailStatus;
    if (index >= Names.Count || (reads <= ShortReads && index == Names.Count - 1)) return 259;
    byte[] value = Datas[index];
    if (reads <= FlipReads && index == 0) { value = (byte[])value.Clone(); value[0] = (byte)(value[0] ^ reads); }
    if (nameLength <= Names[index].Length || dataLength < value.Length) { dataLength = value.Length; return 234; }
    name.Append(Names[index]); nameLength = Names[index].Length;
    type = Types[index] + (reads <= ChangeReads && index == 0 ? 100 + reads : 0);
    Array.Copy(value, data, value.Length); dataLength = value.Length;
    return 0;
  }
  public override int SetValue(IntPtr key, string name, int type, byte[] data, int length) { Log.Append("set [" + name + "] " + type + " " + BitConverter.ToString(data, 0, length).Replace("-", "") + ";"); return SetStatus; }
  public override int DeleteValue(IntPtr key, string name) { Log.Append("delete [" + name + "];"); return DeleteStatus; }
  public override void Close(IntPtr key) { Log.Append("close;"); }
}
`;
  /** 用假的系统调用跑一个主体；`setup` 是配置 `$f`（假实现）的 PowerShell。日志写在 stderr 的最后。 */
  const fake = (setup: string, main: string, vars: Record<string, string> = {}) =>
    withPowerShellScratch((env) =>
      powershellText(
        `${registryPrelude(FAKE_API, "$global:f")}$global:f = [AtmFakeApi]::new(); $f = $global:f; ${setup}\n` +
          `${main}; [Console]::Error.Write('|log ' + $global:f.Log.ToString())`,
        { env, vars: { ATM_TEXT_KEY: "HKCU\\Software\\Synthetic", ...vars }, timeout: 120_000 },
      ),
    );
  const readWith = (setup: string) => registryReply(fake(setup, REGISTRY_MAIN), "synthetic");
  const log = (result: { stderr: string }) =>
    result.stderr.slice(result.stderr.indexOf("|log ") + 5);
  const text = (value: string) => Buffer.from(value, "utf16le").toString("hex").toUpperCase();
  const values = "$f.AddText('a', 1, \"x`0\"); $f.AddText('b', 1, \"yy`0\"); ";

  it.runIf(process.platform === "win32")(
    "注册表：只有 ERROR_FILE_NOT_FOUND 是不在；别的返回码、读的过程中一直在变都抛出，不出空的或半份快照",
    () => {
      // 只读打开（KEY_READ），根照 reg.exe 的写法。
      const ok = fake(values, REGISTRY_MAIN);
      expect(log(ok)).toBe("open 80000001 Software\\Synthetic 20019;close;");
      expect(registryReply(ok, "synthetic")).toEqual({
        a: { type: "REG_SZ", code: 1, data: "x", raw: text("x\0") },
        b: { type: "REG_SZ", code: 1, data: "yy", raw: text("yy\0") },
      });
      expect(readWith("$f.OpenStatus = 2")).toBeNull();
      // .NET 的 OpenSubKey 对这些返回码返回 null（当成不在）：这里一律抛出。
      for (const status of [5, 8, 1018, 1346])
        expect(() => readWith(`$f.OpenStatus = ${status}`), String(status)).toThrow(
          new RegExp(`RegOpenKeyEx on HKCU\\\\Software\\\\Synthetic returned ${status}`, "u"),
        );
      expect(() => readWith(`${values}$f.QueryStatus = 6`)).toThrow(
        /RegQueryInfoKey .* returned 6/u,
      );
      // 读到一半失败（键被删掉、内存不足）：抛出，不是前一半。
      for (const status of [1018, 8, 2])
        expect(() => readWith(`${values}$f.EnumFailAt = 1; $f.EnumFailStatus = ${status}`)).toThrow(
          new RegExp(`RegEnumValue .* returned ${status}`, "u"),
        );
      // 脚本主体自己：失败以 2 退出，stdout 什么都没有。
      const failed = fake(`${values}$f.EnumFailAt = 1; $f.EnumFailStatus = 1018`, REGISTRY_MAIN);
      expect([failed.status, failed.stdout]).toEqual([2, ""]);
      // 值变长（ERROR_MORE_DATA）、少了一个、类型变了、字节变了：重读，连着两次一样才算数；一直在变就抛出。
      for (const change of ["GrowReads", "ShortReads", "ChangeReads", "FlipReads"]) {
        expect(readWith(`${values}$f.${change} = 1`), change).toEqual(
          registryReply(ok, "synthetic"),
        );
        expect(() => readWith(`${values}$f.${change} = 99`), change).toThrow(/kept changing/u);
      }
      // 空键：读到的是空对象，不是 null。
      expect(readWith("")).toEqual({});
    },
    300_000,
  );

  it.runIf(process.platform === "win32")(
    "注册表：值按 reg.exe 的写法给断言看，原始字节原样留着；写回照类型码与字节，一字节不差",
    () => {
      const literal = "AyanamiTaskManager\\0x\0\0";
      const split = "AyanamiTaskManager\0x\0\0";
      const snapshot = readWith(
        "$f.Add('dword', 4, [byte[]](255, 255, 255, 255)); $f.Add('ten', 4, [byte[]](10, 0, 0, 0)); " +
          "$f.Add('qword', 11, [byte[]](255, 255, 255, 255, 255, 255, 255, 255)); $f.Add('short', 4, [byte[]](1, 2)); " +
          "$f.Add('none', 0, [byte[]](0, 255, 128)); $f.Add('bin', 3, [byte[]](1)); $f.Add('odd', 42, [byte[]]@()); " +
          `$f.AddText('literal', 7, "${literal.replace(/\0/gu, "`0")}"); $f.AddText('split', 7, "${split.replace(/\0/gu, "`0")}"); ` +
          "$f.AddText('empty', 7, \"`0\"); $f.AddText('expand', 2, \"%X%`0\"); $f.AddText('', 1, \"default`0\")",
      );
      expect(snapshot).toEqual({
        dword: { type: "REG_DWORD", code: 4, data: "0xffffffff", raw: "FFFFFFFF" },
        ten: { type: "REG_DWORD", code: 4, data: "0xa", raw: "0A000000" },
        qword: { type: "REG_QWORD", code: 11, data: "0xffffffffffffffff", raw: "FFFFFFFFFFFFFFFF" },
        short: { type: "REG_DWORD", code: 4, data: "0102", raw: "0102" },
        none: { type: "REG_NONE", code: 0, data: "00FF80", raw: "00FF80" },
        bin: { type: "REG_BINARY", code: 3, data: "01", raw: "01" },
        odd: { type: "REG_TYPE_42", code: 42, data: "", raw: "" },
        literal: {
          type: "REG_MULTI_SZ",
          code: 7,
          data: "AyanamiTaskManager\\0x",
          raw: text(literal),
        },
        split: { type: "REG_MULTI_SZ", code: 7, data: "AyanamiTaskManager\\0x", raw: text(split) },
        empty: { type: "REG_MULTI_SZ", code: 7, data: "", raw: "0000" },
        expand: { type: "REG_EXPAND_SZ", code: 2, data: "%X%", raw: text("%X%\0") },
        "": { type: "REG_SZ", code: 1, data: "default", raw: text("default\0") },
      });
      // 写回：每个值照快照的类型码与字节交给 RegSetValueEx（含默认值、空的多字符串、未知类型）。
      for (const [name, value] of Object.entries(snapshot!)) {
        const written = fake(
          "",
          REGISTRY_SET_MAIN,
          registryWriteVars("HKCU\\Software\\Synthetic", name, value),
        );
        registryWriteReply(written, "synthetic");
        expect(log(written)).toBe(
          `create Software\\Synthetic;set [${name}] ${value.code} ${value.raw};close;`,
        );
      }
      // 删：值或键本来就不在算删好了；别的返回码抛出。写失败也抛出。
      const remove = registryWriteVars("HKCU\\Software\\Synthetic", "gone");
      const removed = fake("", REGISTRY_SET_MAIN, remove);
      registryWriteReply(removed, "synthetic");
      expect(log(removed)).toBe("open 80000001 Software\\Synthetic 2;delete [gone];close;");
      registryWriteReply(fake("$f.DeleteStatus = 2", REGISTRY_SET_MAIN, remove), "synthetic");
      registryWriteReply(fake("$f.OpenStatus = 2", REGISTRY_SET_MAIN, remove), "synthetic");
      expect(() =>
        registryWriteReply(fake("$f.DeleteStatus = 5", REGISTRY_SET_MAIN, remove), "synthetic"),
      ).toThrow(/RegDeleteValue .* returned 5/u);
      const set = registryWriteVars("HKCU\\Software\\Synthetic", "a", snapshot!["ten"]);
      expect(() =>
        registryWriteReply(fake("$f.SetStatus = 5", REGISTRY_SET_MAIN, set), "synthetic"),
      ).toThrow(/RegSetValueEx .* returned 5/u);
      expect(() =>
        registryWriteReply(fake("$f.CreateStatus = 5", REGISTRY_SET_MAIN, set), "synthetic"),
      ).toThrow(/RegCreateKeyEx .* returned 5/u);
      const bad = fake("", REGISTRY_SET_MAIN, { ...set, ATM_TEXT_RAW: "ABC" });
      expect([bad.status, bad.stdout]).toEqual([2, ""]);
    },
    300_000,
  );

  // peer r17 P2-03：换掉读任务的函数，造出读失败，看主体怎么收场。不碰计划任务。
  const taskWith = (override: string) =>
    taskReply(powershellText(`${TASK_FUNCTIONS}\n${override}\n${TASK_MAIN}`), "synthetic");

  it.runIf(process.platform === "win32")(
    "计划任务：读失败一律抛出；只有确定没有登记是 null",
    () => {
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
