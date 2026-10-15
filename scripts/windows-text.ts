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
 * - 注册表的值、计划任务的定义经 .NET / COM 读出来，不解析 reg.exe、schtasks.exe 的输出；
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

export type RegistryValue = { type: string; data: string };

const REGISTRY_TYPES: Record<string, string> = {
  String: "REG_SZ",
  ExpandString: "REG_EXPAND_SZ",
  Binary: "REG_BINARY",
  DWord: "REG_DWORD",
  QWord: "REG_QWORD",
  MultiString: "REG_MULTI_SZ",
  None: "REG_NONE",
};

/**
 * 读注册表的两个函数（W8 关口 peer r17 P1-02、P2-01）。主体（{@link REGISTRY_MAIN}）只经它们碰注册表，
 * 用例换掉它们来造出读失败、转换失败。
 * - `Open-AtmKey`：只读打开；根照 reg.exe 的写法（`HKCU`、`HKEY_CURRENT_USER` 等）。键不在是 `$null`
 *   （`OpenSubKey` 的约定），没有权限等一律抛出——不用 `Test-Path`，它把拒绝访问也当成「不在」。
 * - `Convert-AtmValue`：值写成 reg.exe query 的样子：二进制（含 REG_NONE 与未知类型）是连续的大写十六进制；
 *   DWORD / QWORD 按位取十六进制（-1 是 `0xffffffff`；`[uint32]` 转换遇到负数会出错，值就成了空对象）；
 *   多字符串用 `\0` 隔开；REG_EXPAND_SZ 不展开。
 */
export const REGISTRY_FUNCTIONS =
  "function Open-AtmKey([string]$key) { " +
  "$i = $key.IndexOf([char]92); " +
  "$hive = if ($i -lt 0) { $key } else { $key.Substring(0, $i) }; " +
  "$sub = if ($i -lt 0) { '' } else { $key.Substring($i + 1) }; " +
  "$root = switch ($hive.ToUpperInvariant()) { " +
  "{ $_ -in 'HKCU', 'HKEY_CURRENT_USER' } { [Microsoft.Win32.Registry]::CurrentUser } " +
  "{ $_ -in 'HKLM', 'HKEY_LOCAL_MACHINE' } { [Microsoft.Win32.Registry]::LocalMachine } " +
  "{ $_ -in 'HKCR', 'HKEY_CLASSES_ROOT' } { [Microsoft.Win32.Registry]::ClassesRoot } " +
  "{ $_ -in 'HKU', 'HKEY_USERS' } { [Microsoft.Win32.Registry]::Users } " +
  "{ $_ -in 'HKCC', 'HKEY_CURRENT_CONFIG' } { [Microsoft.Win32.Registry]::CurrentConfig } " +
  "default { throw ('unknown registry hive: ' + $hive) } }; " +
  "if ($sub -eq '') { return $root }; return $root.OpenSubKey($sub, $false) }; " +
  "function Convert-AtmValue([string]$kind, $v) { " +
  "switch ($kind) { " +
  "{ $_ -in 'DWord', 'QWord' } { return '0x' + $v.ToString('x') } " +
  "'MultiString' { return [string]::Join('\\0', [string[]]$v) } " +
  "{ $_ -in 'String', 'ExpandString' } { return [string]$v } " +
  "default { return -join ([byte[]]$v | ForEach-Object { $_.ToString('X2') }) } } }; ";

/**
 * 读注册表的主体：任何一步出错（打开、列名字、读值、转换、序列化）都以 2 退出，stdout 什么都不写——
 * 结果攒齐了才一次写出，不会有半份快照。只有确定的「键不在」以 {@link ABSENT} 退出。
 */
export const REGISTRY_MAIN =
  "$ErrorActionPreference = 'Stop'; " +
  "try { " +
  "$k = Open-AtmKey $env:ATM_TEXT_KEY; " +
  `if ($null -eq $k) { exit ${ABSENT} }; ` +
  "$o = [ordered]@{}; " +
  "foreach ($n in $k.GetValueNames()) { " +
  "$kind = $k.GetValueKind($n).ToString(); " +
  "$o[$n] = [ordered]@{ type = $kind; data = (Convert-AtmValue $kind $k.GetValue($n, $null, 'DoNotExpandEnvironmentNames')) } }; " +
  "$json = ConvertTo-Json -InputObject $o -Compress -Depth 3 " +
  "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }; " +
  "[Console]::Out.Write($json)";

/**
 * 注册表 JSON（{@link REGISTRY_MAIN} 的输出）换成 reg.exe 的类型名。形状不对（不是对象、某个值没有字符串
 * 的 type / data、空输出）一律抛出：半份或坏掉的快照会让还原把用户原来的值当成本轮新加的删掉（peer r17 P1-02）。
 */
export function parseRegistryJson(json: string): Record<string, RegistryValue> {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`注册表读出的不是对象：${json.slice(0, 200)}`);
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([name, value]) => {
      const entry = value as { type?: unknown; data?: unknown } | null;
      if (!entry || typeof entry.type !== "string" || typeof entry.data !== "string")
        throw new Error(`注册表值「${name}」的形状不对：${JSON.stringify(value)}`);
      return [name, { type: REGISTRY_TYPES[entry.type] ?? "REG_NONE", data: entry.data }];
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

/** 一个注册表键（如 `HKCU\Software\…`）的全部值；键不在是 null，读失败抛出。只读。 */
export function registryValues(key: string): Record<string, RegistryValue> | null {
  return registryReply(
    powershellText(REGISTRY_FUNCTIONS + REGISTRY_MAIN, { vars: { ATM_TEXT_KEY: key } }),
    key,
  );
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
