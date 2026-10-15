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

/** 键不在、任务不在：脚本以这个码退出。 */
const ABSENT = 3;

export type RegistryValue = { type: string; data: string };

const REGISTRY_TYPES: Record<string, string> = {
  String: "REG_SZ",
  ExpandString: "REG_EXPAND_SZ",
  Binary: "REG_BINARY",
  DWord: "REG_DWORD",
  QWord: "REG_QWORD",
  MultiString: "REG_MULTI_SZ",
};

// 值的写法与 reg.exe query 一样：二进制是连续的大写十六进制，DWORD / QWORD 是 0x 加小写十六进制，
// 多字符串用 `\0` 隔开；REG_EXPAND_SZ 不展开。
const REGISTRY_SCRIPT =
  "$p = 'Registry::' + $env:ATM_TEXT_KEY; " +
  `if (-not (Test-Path -LiteralPath $p)) { exit ${ABSENT} }; ` +
  "$k = Get-Item -LiteralPath $p; $o = [ordered]@{}; " +
  "foreach ($n in $k.GetValueNames()) { " +
  "$kind = $k.GetValueKind($n).ToString(); " +
  "$v = $k.GetValue($n, $null, 'DoNotExpandEnvironmentNames'); " +
  "$d = switch ($kind) { " +
  "'Binary' { -join ($v | ForEach-Object { $_.ToString('X2') }) } " +
  "'DWord' { '0x' + ([uint32]$v).ToString('x') } " +
  "'QWord' { '0x' + ([uint64]$v).ToString('x') } " +
  "'MultiString' { $v -join '\\0' } " +
  "default { [string]$v } }; " +
  "$o[$n] = [ordered]@{ type = $kind; data = $d } }; " +
  "ConvertTo-Json -InputObject $o -Compress -Depth 3";

/** 注册表 JSON（{@link registryValues} 的脚本的输出）换成 reg.exe 的类型名。 */
export function parseRegistryJson(json: string): Record<string, RegistryValue> {
  const parsed = JSON.parse(json || "{}") as Record<string, { type: string; data: string }>;
  return Object.fromEntries(
    Object.entries(parsed).map(([name, value]) => [
      name,
      { type: REGISTRY_TYPES[value.type] ?? "REG_NONE", data: value.data },
    ]),
  );
}

/** 一个注册表键（如 `HKCU\Software\…`）的全部值；键不在是 null，读失败抛出。只读。 */
export function registryValues(key: string): Record<string, RegistryValue> | null {
  const result = powershellText(REGISTRY_SCRIPT, { vars: { ATM_TEXT_KEY: key } });
  if (result.error) throw result.error;
  if (result.status === ABSENT) return null;
  if (result.status !== 0)
    throw new Error(`读注册表 ${key} 失败（${result.status}）：${result.stderr}`);
  return parseRegistryJson(result.stdout.trim());
}

// 经 Schedule.Service（COM），不经 ScheduledTasks 模块（它走 WMI）。0x80070002 是「没有这个任务」。
const TASK_SCRIPT =
  "$s = New-Object -ComObject Schedule.Service; $s.Connect(); " +
  "try { $t = $s.GetFolder('\\').GetTask($env:ATM_TEXT_TASK) } catch { " +
  "$e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; " +
  `if ($e.HResult -eq -2147024894) { exit ${ABSENT} }; exit 2 }; ` +
  "[Console]::Out.Write($t.Xml)";

/** 计划任务根目录下这个名字的任务定义（XML）；没有登记是 null，读失败抛出。只读，不改计划任务。 */
export function scheduledTaskXml(name: string): string | null {
  const result = powershellText(TASK_SCRIPT, { vars: { ATM_TEXT_TASK: name } });
  if (result.error) throw result.error;
  if (result.status === ABSENT) return null;
  if (result.status !== 0)
    throw new Error(`读计划任务「${name}」失败（${result.status}）：${result.stderr}`);
  return result.stdout;
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
