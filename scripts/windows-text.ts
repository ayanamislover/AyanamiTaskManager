import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { withPowerShellScratch } from "./powershell-scratch.js";

/**
 * 脚本读 Windows 的文字一律走 Unicode（W8 关口 peer r16 P2-01）。
 *
 * Windows PowerShell 5.1 的 stdout 按系统代码页编码（中文系统 936、英文系统 1252），reg.exe、
 * schtasks.exe 的输出也一样；按 UTF-8 解码，代码页表示不了的字符就成了替换字符，路径比较、
 * 「没有残留进程」这类检查会空转。WScript.Shell 的快捷方式对象收发的也是 ANSI 字符串。本机是
 * 中文系统，中文名恰好都过得去，W8 第三次 CI（英文系统）才红在 `ATM 修复.lnk` 上。
 *
 * 所以：
 * - PowerShell 的 `-Command` 一律经 {@link powershellArgs}，先把输出设成 UTF-8；
 * - 注册表经 advapi32 读写（{@link REGISTRY_SOURCE}），计划任务的定义经 COM 读，不解析 reg.exe、
 *   schtasks.exe 的输出；
 * - 快捷方式经 IShellLinkW 写、经 Shell.Application 读；
 * - 路径、键名、任务名都经环境变量传，不拼进脚本文本。
 *
 * 守卫：apps/desktop/test/windows-text.test.ts、shortcut-reading.test.ts。
 */
export const UTF8_OUTPUT = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; ";

/** `powershell.exe` 的参数：`-NoProfile -NonInteractive <flags> -Command <先设 UTF-8 输出的脚本>`。 */
export function powershellArgs(script: string, flags: readonly string[] = []): string[] {
  return ["-NoProfile", "-NonInteractive", ...flags, "-Command", UTF8_OUTPUT + script];
}

export type TextOptions = {
  /** 基础环境，默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 再加上的变量：脚本要用的路径、名字都从这里传。 */
  vars?: Record<string, string>;
  timeout?: number;
  maxBuffer?: number;
};

/** 跑一段 PowerShell，按 UTF-8 收它的输出。 */
export function powershellText(
  script: string,
  options: TextOptions = {},
): SpawnSyncReturns<string> {
  return spawnSync("powershell.exe", powershellArgs(script), {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    env: { ...(options.env ?? process.env), ...options.vars },
  });
}

/** 键不在、任务不在：脚本以这个码退出。别的失败退出 2，stdout 什么都不写。 */
const ABSENT = 3;

/**
 * 一个注册表值。`type` 是 reg.exe 的类型名，`data` 是 reg.exe query 的写法（给断言看）；`code` 与 `raw`
 * （原始字节，连续的大写十六进制）是还原用的，按它们写回就和原来一字节不差（W8 关口 peer r18 P2-01：
 * 多字符串用 `\0` 拼成文字不是一一对应的，含字面 `\0` 的元素还原不回来）。
 */
export type RegistryValue = { type: string; code: number; data: string; raw: string };

/**
 * 读写注册表的 C#（W8 关口 peer r18 P1-01）。直接调 advapi32，每一步的返回码都留着：
 * - `RegOpenKeyExW` 只有 ERROR_FILE_NOT_FOUND（2）是「键不在」，别的返回码一律抛出。.NET 的
 *   `RegistryKey.OpenSubKey` 只对拒绝访问抛出，KEY_DELETED、内存不足之类直接返回 null，和「不在」分不开；
 *   `GetValue` 读值失败时返回默认值。所以不用 `Microsoft.Win32.Registry`。
 * - 值经 `RegEnumValueW` 一次连名字、类型、字节一起读出；ERROR_NO_MORE_ITEMS 之外的返回码一律抛出。
 *   读的过程中键变了（值变长、个数对不上）就整份重读；连着两次读到的一样才算数，读 5 次还不稳定就抛出。
 * - 写回经 `RegSetValueExW`，类型码与字节照快照原样。
 * 系统调用都经 `AtmRegApi`：用例换上假的实现，造出各种返回码，走的仍是这里的判断。
 * 源码里不写反斜杠（这段文字放在 TS 模板串里）。
 */
export const REGISTRY_SOURCE = `using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public abstract class AtmRegApi {
  public abstract int Open(UIntPtr root, string sub, int access, out IntPtr key);
  public abstract int Create(UIntPtr root, string sub, int access, out IntPtr key);
  public abstract int QueryInfo(IntPtr key, out int values, out int maxName, out int maxData);
  public abstract int EnumValue(IntPtr key, int index, StringBuilder name, ref int nameLength, out int type, byte[] data, ref int dataLength);
  public abstract int SetValue(IntPtr key, string name, int type, byte[] data, int length);
  public abstract int DeleteValue(IntPtr key, string name);
  public abstract void Close(IntPtr key);
}

public sealed class AtmRegNative : AtmRegApi {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  static extern int RegOpenKeyExW(UIntPtr key, string sub, int options, int access, out IntPtr result);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  static extern int RegCreateKeyExW(UIntPtr key, string sub, int reserved, string cls, int options, int access, IntPtr security, out IntPtr result, out int disposition);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  static extern int RegQueryInfoKeyW(IntPtr key, IntPtr cls, IntPtr clsLength, IntPtr reserved, IntPtr subKeys, IntPtr maxSubKey, IntPtr maxClass, out int values, out int maxName, out int maxData, IntPtr security, IntPtr lastWrite);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  static extern int RegEnumValueW(IntPtr key, int index, StringBuilder name, ref int nameLength, IntPtr reserved, out int type, byte[] data, ref int dataLength);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  static extern int RegSetValueExW(IntPtr key, string name, int reserved, int type, byte[] data, int length);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  static extern int RegDeleteValueW(IntPtr key, string name);
  [DllImport("advapi32.dll")]
  static extern int RegCloseKey(IntPtr key);

  public override int Open(UIntPtr root, string sub, int access, out IntPtr key) { return RegOpenKeyExW(root, sub, 0, access, out key); }
  public override int Create(UIntPtr root, string sub, int access, out IntPtr key) { int disposition; return RegCreateKeyExW(root, sub, 0, null, 0, access, IntPtr.Zero, out key, out disposition); }
  public override int QueryInfo(IntPtr key, out int values, out int maxName, out int maxData) { return RegQueryInfoKeyW(key, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out values, out maxName, out maxData, IntPtr.Zero, IntPtr.Zero); }
  public override int EnumValue(IntPtr key, int index, StringBuilder name, ref int nameLength, out int type, byte[] data, ref int dataLength) { return RegEnumValueW(key, index, name, ref nameLength, IntPtr.Zero, out type, data, ref dataLength); }
  public override int SetValue(IntPtr key, string name, int type, byte[] data, int length) { return RegSetValueExW(key, name, 0, type, data, length); }
  public override int DeleteValue(IntPtr key, string name) { return RegDeleteValueW(key, name); }
  public override void Close(IntPtr key) { RegCloseKey(key); }
}

public sealed class AtmRegValue {
  public string Name; public int Code; public string Type; public string Data; public string Raw;
}

public static class AtmRegistry {
  const int NotFound = 2, MoreData = 234, NoMoreItems = 259;
  const int KeyRead = 0x20019, KeySetValue = 0x2;
  const int Attempts = 5;

  static void Split(string key, out UIntPtr root, out string sub) {
    int i = key.IndexOf((char)92);
    string hive = (i < 0 ? key : key.Substring(0, i)).ToUpperInvariant();
    sub = i < 0 ? "" : key.Substring(i + 1);
    switch (hive) {
      case "HKCR": case "HKEY_CLASSES_ROOT": root = new UIntPtr(0x80000000u); break;
      case "HKCU": case "HKEY_CURRENT_USER": root = new UIntPtr(0x80000001u); break;
      case "HKLM": case "HKEY_LOCAL_MACHINE": root = new UIntPtr(0x80000002u); break;
      case "HKU": case "HKEY_USERS": root = new UIntPtr(0x80000003u); break;
      case "HKCC": case "HKEY_CURRENT_CONFIG": root = new UIntPtr(0x80000005u); break;
      default: throw new ArgumentException("unknown registry hive: " + hive);
    }
  }

  static Exception Fail(string call, int status, string key) {
    return new Win32Exception(status, call + " on " + key + " returned " + status + ": " + new Win32Exception(status).Message);
  }

  /** 键的全部值；只有键确实不在是 null。 */
  public static AtmRegValue[] Read(AtmRegApi api, string key) {
    UIntPtr root; string sub; Split(key, out root, out sub);
    IntPtr handle;
    int status = api.Open(root, sub, KeyRead, out handle);
    if (status == NotFound) return null;
    if (status != 0) throw Fail("RegOpenKeyEx", status, key);
    try {
      AtmRegValue[] previous = null;
      for (int attempt = 0; attempt < Attempts; attempt++) {
        AtmRegValue[] current = ReadOnce(api, handle, key);
        if (current != null && previous != null && Same(previous, current)) return current;
        previous = current;
      }
      throw new InvalidOperationException("the values of " + key + " kept changing while they were read");
    } finally {
      api.Close(handle);
    }
  }

  /** 读一遍；读的过程中键变了（值比 RegQueryInfoKey 说的长、个数对不上）是 null，由调用方重读。 */
  static AtmRegValue[] ReadOnce(AtmRegApi api, IntPtr handle, string key) {
    int count, maxName, maxData;
    int status = api.QueryInfo(handle, out count, out maxName, out maxData);
    if (status != 0) throw Fail("RegQueryInfoKey", status, key);
    List<AtmRegValue> values = new List<AtmRegValue>();
    for (int index = 0; ; index++) {
      StringBuilder name = new StringBuilder(maxName + 1);
      int nameLength = maxName + 1;
      byte[] data = new byte[Math.Max(maxData, 1)];
      int dataLength = data.Length;
      int type;
      status = api.EnumValue(handle, index, name, ref nameLength, out type, data, ref dataLength);
      if (status == NoMoreItems) break;
      if (status == MoreData) return null;
      if (status != 0) throw Fail("RegEnumValue", status, key);
      values.Add(Convert(name.ToString(0, nameLength), type, data, dataLength));
    }
    return values.Count == count ? values.ToArray() : null;
  }

  static bool Same(AtmRegValue[] left, AtmRegValue[] right) {
    if (left.Length != right.Length) return false;
    for (int i = 0; i < left.Length; i++)
      if (left[i].Name != right[i].Name || left[i].Code != right[i].Code || left[i].Raw != right[i].Raw) return false;
    return true;
  }

  static string TypeName(int code) {
    switch (code) {
      case 0: return "REG_NONE";
      case 1: return "REG_SZ";
      case 2: return "REG_EXPAND_SZ";
      case 3: return "REG_BINARY";
      case 4: return "REG_DWORD";
      case 5: return "REG_DWORD_BIG_ENDIAN";
      case 6: return "REG_LINK";
      case 7: return "REG_MULTI_SZ";
      case 8: return "REG_RESOURCE_LIST";
      case 9: return "REG_FULL_RESOURCE_DESCRIPTOR";
      case 10: return "REG_RESOURCE_REQUIREMENTS_LIST";
      case 11: return "REG_QWORD";
      default: return "REG_TYPE_" + code;
    }
  }

  static string Hex(byte[] data, int length) {
    StringBuilder hex = new StringBuilder(length * 2);
    for (int i = 0; i < length; i++) hex.Append(data[i].ToString("X2"));
    return hex.ToString();
  }

  static byte[] Unhex(string hex) {
    if (hex.Length % 2 != 0) throw new ArgumentException("raw registry data has an odd number of hex digits");
    byte[] data = new byte[hex.Length / 2];
    for (int i = 0; i < data.Length; i++) data[i] = System.Convert.ToByte(hex.Substring(i * 2, 2), 16);
    return data;
  }

  /** reg.exe query 的写法：字符串到第一个 NUL；多字符串用字面的反斜杠加 0 隔开；DWORD / QWORD 按位取十六进制；其余是十六进制。 */
  public static AtmRegValue Convert(string name, int code, byte[] data, int length) {
    AtmRegValue value = new AtmRegValue();
    value.Name = name; value.Code = code; value.Type = TypeName(code); value.Raw = Hex(data, length);
    string text = Encoding.Unicode.GetString(data, 0, length - length % 2);
    switch (code) {
      case 1: case 2: {
        int end = text.IndexOf((char)0);
        value.Data = end < 0 ? text : text.Substring(0, end);
        break;
      }
      case 7: {
        List<string> items = new List<string>(text.Split((char)0));
        while (items.Count > 0 && items[items.Count - 1].Length == 0) items.RemoveAt(items.Count - 1);
        value.Data = string.Join(new string((char)92, 1) + "0", items.ToArray());
        break;
      }
      case 4: value.Data = length == 4 ? "0x" + BitConverter.ToUInt32(data, 0).ToString("x") : value.Raw; break;
      case 11: value.Data = length == 8 ? "0x" + BitConverter.ToUInt64(data, 0).ToString("x") : value.Raw; break;
      default: value.Data = value.Raw; break;
    }
    return value;
  }

  /** 照类型码与原始字节写回一个值；键不在就建出来。 */
  public static void Set(AtmRegApi api, string key, string name, int code, string raw) {
    byte[] data = Unhex(raw);
    UIntPtr root; string sub; Split(key, out root, out sub);
    IntPtr handle;
    int status = api.Create(root, sub, KeySetValue, out handle);
    if (status != 0) throw Fail("RegCreateKeyEx", status, key);
    try {
      status = api.SetValue(handle, name, code, data, data.Length);
      if (status != 0) throw Fail("RegSetValueEx", status, key);
    } finally {
      api.Close(handle);
    }
  }

  /** 删一个值；键或值本来就不在算删好了，别的返回码抛出。 */
  public static void Delete(AtmRegApi api, string key, string name) {
    UIntPtr root; string sub; Split(key, out root, out sub);
    IntPtr handle;
    int status = api.Open(root, sub, KeySetValue, out handle);
    if (status == NotFound) return;
    if (status != 0) throw Fail("RegOpenKeyEx", status, key);
    try {
      status = api.DeleteValue(handle, name);
      if (status != 0 && status != NotFound) throw Fail("RegDeleteValue", status, key);
    } finally {
      api.Close(handle);
    }
  }
}
`;

/**
 * 编译 {@link REGISTRY_SOURCE}（再加上 `extra`，用例的假实现放这里），定义 `New-AtmRegistryApi`。
 * 生产用真实的系统调用；用例传 `api` 换掉它。
 */
export function registryPrelude(extra = "", api = "[AtmRegNative]::new()"): string {
  return `Add-Type -TypeDefinition @'\n${REGISTRY_SOURCE}\n${extra}\n'@\nfunction New-AtmRegistryApi { ${api} }\n`;
}

/**
 * 读注册表的主体：任何一步出错（打开、列值、读值、序列化）都以 2 退出，stdout 什么都不写——
 * 结果攒齐了才一次写出，不会有半份快照。只有确定的「键不在」以 {@link ABSENT} 退出。
 */
export const REGISTRY_MAIN =
  "$ErrorActionPreference = 'Stop'; " +
  "try { " +
  "$values = [AtmRegistry]::Read((New-AtmRegistryApi), [string]$env:ATM_TEXT_KEY); " +
  `if ($null -eq $values) { exit ${ABSENT} }; ` +
  "$o = [ordered]@{}; " +
  "foreach ($v in $values) { $o[$v.Name] = [ordered]@{ type = $v.Type; code = $v.Code; data = $v.Data; raw = $v.Raw } }; " +
  "$json = ConvertTo-Json -InputObject $o -Compress -Depth 3 " +
  "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }; " +
  "[Console]::Out.Write($json)";

/**
 * 写回或删掉一个值的主体。值名经 `ATM_TEXT_NAME` 传，前面多一个 `=`：空名字（键的默认值）的环境变量
 * 在 PowerShell 里读回来分不清是空串还是没设。成功时 stdout 是 `ok`，失败以 2 退出。
 */
export const REGISTRY_SET_MAIN =
  "$ErrorActionPreference = 'Stop'; " +
  "try { " +
  "$name = ([string]$env:ATM_TEXT_NAME).Substring(1); " +
  "if ($env:ATM_TEXT_ACTION -eq 'delete') { [AtmRegistry]::Delete((New-AtmRegistryApi), [string]$env:ATM_TEXT_KEY, $name) } " +
  "else { [AtmRegistry]::Set((New-AtmRegistryApi), [string]$env:ATM_TEXT_KEY, $name, [int]$env:ATM_TEXT_CODE, [string]$env:ATM_TEXT_RAW) } " +
  "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }; " +
  "[Console]::Out.Write('ok')";

const RAW = /^(?:[0-9A-F]{2})*$/u;

/**
 * 注册表 JSON（{@link REGISTRY_MAIN} 的输出）。形状不对（不是对象、某个值缺了 type / code / data / raw、
 * raw 不是十六进制、空输出）一律抛出：半份或坏掉的快照会让还原把用户原来的值当成本轮新加的删掉（peer r17 P1-02）。
 */
export function parseRegistryJson(json: string): Record<string, RegistryValue> {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`注册表读出的不是对象：${json.slice(0, 200)}`);
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([name, value]) => {
      const entry = value as Partial<Record<keyof RegistryValue, unknown>> | null;
      if (
        !entry ||
        typeof entry.type !== "string" ||
        typeof entry.data !== "string" ||
        !Number.isInteger(entry.code) ||
        (entry.code as number) < 0 ||
        typeof entry.raw !== "string" ||
        !RAW.test(entry.raw)
      )
        throw new Error(`注册表值「${name}」的形状不对：${JSON.stringify(value)}`);
      return [
        name,
        { type: entry.type, code: entry.code as number, data: entry.data, raw: entry.raw },
      ];
    }),
  );
}

/** 读注册表脚本的结果：退出 {@link ABSENT} 是键不在（null）；0 且输出完整才算读到；别的一律抛出。 */
export function registryReply(
  result: SpawnSyncReturns<string>,
  key: string,
): Record<string, RegistryValue> | null {
  if (result.error) throw result.error;
  if (result.status === ABSENT) return null;
  if (result.status !== 0)
    throw new Error(`读注册表 ${key} 失败（${result.status}）：${result.stderr}`);
  return parseRegistryJson(result.stdout);
}

/** 写注册表脚本的结果：0 且 stdout 是 `ok` 才算写成；别的一律抛出。 */
export function registryWriteReply(result: SpawnSyncReturns<string>, key: string): void {
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout !== "ok")
    throw new Error(`写注册表 ${key} 失败（${result.status}）：${result.stderr}`);
}

/** 跑一段要 Add-Type 的注册表脚本：编译目录落在 output/ 下的临时根，用完删掉（见 powershell-scratch.ts）。 */
function registryScript(main: string, vars: Record<string, string>): SpawnSyncReturns<string> {
  return withPowerShellScratch((env) =>
    powershellText(registryPrelude() + main, { env, vars, timeout: 120_000 }),
  );
}

/** 一个注册表键（如 `HKCU\Software\…`）的全部值；键不在是 null，读失败抛出。只读。 */
export function registryValues(key: string): Record<string, RegistryValue> | null {
  return registryReply(registryScript(REGISTRY_MAIN, { ATM_TEXT_KEY: key }), key);
}

/** {@link REGISTRY_SET_MAIN} 的变量：有 `value` 是照它写回，没有是删掉。 */
export function registryWriteVars(
  key: string,
  name: string,
  value?: RegistryValue,
): Record<string, string> {
  return value
    ? {
        ATM_TEXT_KEY: key,
        ATM_TEXT_NAME: `=${name}`,
        ATM_TEXT_ACTION: "set",
        ATM_TEXT_CODE: String(value.code),
        ATM_TEXT_RAW: value.raw,
      }
    : { ATM_TEXT_KEY: key, ATM_TEXT_NAME: `=${name}`, ATM_TEXT_ACTION: "delete" };
}

/** 照快照写回一个值（类型码与原始字节原样）。写不成抛出。 */
export function registrySet(key: string, name: string, value: RegistryValue): void {
  registryWriteReply(registryScript(REGISTRY_SET_MAIN, registryWriteVars(key, name, value)), key);
}

/** 删掉一个值；本来就不在算删好了。删不成抛出。 */
export function registryDelete(key: string, name: string): void {
  registryWriteReply(registryScript(REGISTRY_SET_MAIN, registryWriteVars(key, name)), key);
}

/**
 * 读计划任务定义的函数（W8 关口 peer r17 P2-03）。经 Schedule.Service（COM），不经 ScheduledTasks 模块
 * （它走 WMI）。只有 0x80070002（没有这个任务）返回 `$null`；连接、取任务、读 Xml 的别的失败都抛出。
 */
export const TASK_FUNCTIONS =
  "function Read-AtmTaskXml([string]$name) { " +
  "$s = New-Object -ComObject Schedule.Service; $s.Connect(); " +
  "try { $t = $s.GetFolder([string][char]92).GetTask($name) } catch { " +
  "$e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; " +
  "if ($e.HResult -eq -2147024894) { return $null }; throw }; " +
  "return [string]$t.Xml }; ";

/** 读任务定义的主体：出错或读出来的不是任务 XML 都以 2 退出，stdout 什么都不写。 */
export const TASK_MAIN =
  "$ErrorActionPreference = 'Stop'; " +
  "try { " +
  "$x = Read-AtmTaskXml $env:ATM_TEXT_TASK; " +
  `if ($null -eq $x) { exit ${ABSENT} }; ` +
  "if (-not $x.Contains('<Task')) { throw 'the task definition read back is not task XML' } " +
  "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }; " +
  "[Console]::Out.Write($x)";

/** 读任务脚本的结果：退出 {@link ABSENT} 是没有登记（null）；0 且是任务 XML 才算读到；别的一律抛出。 */
export function taskReply(result: SpawnSyncReturns<string>, name: string): string | null {
  if (result.error) throw result.error;
  if (result.status === ABSENT) return null;
  if (result.status !== 0 || !result.stdout.includes("<Task"))
    throw new Error(`读计划任务「${name}」失败（${result.status}）：${result.stderr}`);
  return result.stdout;
}

/** 计划任务根目录下这个名字的任务定义（XML）；没有登记是 null，读失败抛出。只读，不改计划任务。 */
export function scheduledTaskXml(name: string): string | null {
  return taskReply(
    powershellText(TASK_FUNCTIONS + TASK_MAIN, { vars: { ATM_TEXT_TASK: name } }),
    name,
  );
}

/** Shell.Application 的一个快捷方式条目上跑 `select`，返回它的 JSON。 */
function shellItem(path: string, select: string): string {
  const script =
    "$p = $env:ATM_TEXT_SHORTCUT; " +
    "$item = (New-Object -ComObject Shell.Application).Namespace([IO.Path]::GetDirectoryName($p)).ParseName([IO.Path]::GetFileName($p)); " +
    `${select} | ConvertTo-Json -Compress`;
  return powershellText(script, { vars: { ATM_TEXT_SHORTCUT: path } }).stdout.trim();
}

export type ShortcutFields = { target: string; args: string; workdir: string };

/** 快捷方式的目标、参数、工作目录；文件不在或读不出是 null。 */
export function readShortcut(path: string): ShortcutFields | null {
  const reply = shellItem(
    path,
    "$l = $item.GetLink; [pscustomobject]@{ target = $l.Path; args = $l.Arguments; workdir = $l.WorkingDirectory }",
  );
  return JSON.parse(reply || "null") as ShortcutFields | null;
}

/** 快捷方式的 AppUserModel.ID 与 ToastActivatorCLSID（Shell 属性系统）。 */
export function readShortcutIdentity(path: string): { aumid: string; toast: string } {
  const reply = shellItem(
    path,
    "[pscustomobject]@{ aumid = [string]$item.ExtendedProperty('System.AppUserModel.ID'); toast = [string]$item.ExtendedProperty('System.AppUserModel.ToastActivatorCLSID') }",
  );
  return JSON.parse(reply || '{"aumid":"","toast":""}') as { aumid: string; toast: string };
}

// IShellLinkW + IPersistFile：路径全程是宽字符串。vtable 顺序照 ShObjIdl_core.h，前面的方法只占位。
const SHORTCUT_WRITER = `Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
class AtmShellLink {}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
interface IAtmShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int cch, IntPtr data, uint flags);
  void GetIDList(out IntPtr pidl);
  void SetIDList(IntPtr pidl);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int cch);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int cch);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int cch);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
  void GetHotkey(out short key);
  void SetHotkey(short key);
  void GetShowCmd(out int cmd);
  void SetShowCmd(int cmd);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int cch, out int index);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
  void Resolve(IntPtr hwnd, uint flags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
interface IAtmPersistFile {
  void GetClassID(out Guid id);
  [PreserveSig] int IsDirty();
  void Load([MarshalAs(UnmanagedType.LPWStr)] string file, uint mode);
  void Save([MarshalAs(UnmanagedType.LPWStr)] string file, [MarshalAs(UnmanagedType.Bool)] bool remember);
  void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string file);
  void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string file);
}
public static class AtmShortcutWriter {
  public static void Write(string lnk, string target, string workdir, string args) {
    IAtmShellLinkW link = (IAtmShellLinkW)new AtmShellLink();
    link.SetPath(target);
    link.SetWorkingDirectory(workdir);
    link.SetArguments(args);
    ((IAtmPersistFile)link).Save(lnk, true);
  }
}
"@
[AtmShortcutWriter]::Write([string]$env:ATM_TEXT_SHORTCUT, [string]$env:ATM_TEXT_TARGET, [string]$env:ATM_TEXT_WORKDIR, [string]$env:ATM_TEXT_ARGS)
`;

/** 写一个快捷方式（IShellLinkW，不受代码页限制）。写不成抛出。 */
export function writeShortcut(path: string, fields: ShortcutFields): void {
  const result = withPowerShellScratch((env) =>
    powershellText(SHORTCUT_WRITER, {
      env,
      vars: {
        ATM_TEXT_SHORTCUT: path,
        ATM_TEXT_TARGET: fields.target,
        ATM_TEXT_WORKDIR: fields.workdir,
        ATM_TEXT_ARGS: fields.args,
      },
      timeout: 60_000,
    }),
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`写快捷方式 ${path} 失败（${result.status}）：${result.stderr}`);
}
