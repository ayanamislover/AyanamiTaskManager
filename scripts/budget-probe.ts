/**
 * 预算测量用的常驻 PowerShell 进程探针（Toolhelp32 进程树 + 出生身份 + 标量查询）。
 * 单独成模块、无副作用：budget-measure.ts 用它，测试也能直接真编译、真跑。
 */
export type ProcessRow = {
  pid: number;
  ppid: number;
  exe: string;
  ws: number;
  priv: number;
  /** 出生时间（.NET ticks，UTC）：与树成员身份一起取，之后按它认人。 */
  ticks: string;
};

export type ProcessTree = { rows: ProcessRow[]; unknown: number[] };

/** alive 的回答里只有这两种算「记下的那个进程已经不在」；其余（含协议错误）都是查不了。 */
export const EXITED_STATES: ReadonlySet<string> = new Set(["gone", "other"]);

export const BUDGET_PROBE = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class AtmBudgetProbe {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Entry {
    public uint Size; public uint Usage; public uint Pid; public IntPtr Heap; public uint Module;
    public uint Threads; public uint Parent; public int Priority; public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe;
  }
  [DllImport("kernel32.dll")] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("user32.dll")] private static extern bool PostMessageW(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  // 拿住进程句柄（句柄关闭前 PID 不会被复用）再读出生时间：ok / gone（已退出）/ unknown（查不了）。
  private static string Pin(int pid, out Process process, out DateTime started) {
    process = null;
    started = DateTime.MinValue;
    try { process = Process.GetProcessById(pid); } catch (ArgumentException) { return "gone"; } catch { return "unknown"; }
    try {
      IntPtr pinned = process.Handle;
      started = process.StartTime.ToUniversalTime();
      return "ok";
    } catch (InvalidOperationException) { process.Dispose(); process = null; return "gone"; }
    catch { process.Dispose(); process = null; return "unknown"; }
  }
  // 树成员与出生时间在同一个句柄上取：快照之后才出生的是 PID 被复用后的别人，早于父进程出生的
  // 不是它的子孙（父 PID 被复用过）；两者都不是这棵树的成员。查不了身份或内存的成员单列为
  // unknown，不悄悄丢掉。整次查询失败由调用方的 catch 输出 null。
  public static string Tree(int root) {
    var children = new Dictionary<int, List<int>>();
    var names = new Dictionary<int, string>();
    var parents = new Dictionary<int, int>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("CreateToolhelp32Snapshot");
    DateTime taken = DateTime.UtcNow;
    var pinned = new List<Process>();
    try {
      var entry = new Entry { Size = (uint)Marshal.SizeOf(typeof(Entry)) };
      for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
        List<int> list;
        if (!children.TryGetValue((int)entry.Parent, out list)) children[(int)entry.Parent] = list = new List<int>();
        list.Add((int)entry.Pid);
        parents[(int)entry.Pid] = (int)entry.Parent;
        names[(int)entry.Pid] = entry.Exe;
      }
      var tree = new List<int>();
      var started = new Dictionary<int, DateTime>();
      var processes = new Dictionary<int, Process>();
      var unknown = new List<int>();
      Process process = null;
      DateTime birth = DateTime.MinValue;
      string state = names.ContainsKey(root) ? Pin(root, out process, out birth) : "gone";
      if (state == "unknown") unknown.Add(root);
      if (state == "ok") {
        if (birth > taken) process.Dispose();
        else { pinned.Add(process); processes[root] = process; started[root] = birth; tree.Add(root); }
      }
      for (int index = 0; index < tree.Count; index++) {
        List<int> list;
        if (!children.TryGetValue(tree[index], out list)) continue;
        foreach (int child in list) {
          if (child == tree[index] || started.ContainsKey(child)) continue;
          state = Pin(child, out process, out birth);
          if (state == "unknown") { unknown.Add(child); continue; }
          if (state != "ok") continue;
          if (birth > taken || birth < started[tree[index]]) { process.Dispose(); continue; }
          pinned.Add(process);
          processes[child] = process;
          started[child] = birth;
          tree.Add(child);
        }
      }
      var rows = new List<string>();
      foreach (int pid in tree) {
        long ws, priv;
        try { ws = processes[pid].WorkingSet64; priv = processes[pid].PrivateMemorySize64; }
        catch { unknown.Add(pid); continue; }
        rows.Add("{\\"pid\\":" + pid + ",\\"ppid\\":" + parents[pid] + ",\\"exe\\":\\"" + names[pid] + "\\",\\"ws\\":" + ws + ",\\"priv\\":" + priv + ",\\"ticks\\":\\"" + started[pid].Ticks + "\\"}");
      }
      return "{\\"rows\\":[" + string.Join(",", rows.ToArray()) + "],\\"unknown\\":[" + string.Join(",", unknown.ConvertAll(pid => pid.ToString()).ToArray()) + "]}";
    } finally {
      foreach (var held in pinned) held.Dispose();
      CloseHandle(snapshot);
    }
  }
  public static string Close(long hwnd) {
    return PostMessageW(new IntPtr(hwnd), 0x0010, IntPtr.Zero, IntPtr.Zero) ? "true" : "false";
  }
  // PID 上是不是记下的那个进程：same / gone（没了）/ other（PID 已给了别人）/ unknown（查不了）。
  public static string Alive(int pid, long ticks) {
    Process process;
    try { process = Process.GetProcessById(pid); } catch (ArgumentException) { return "gone"; } catch { return "unknown"; }
    try { return process.StartTime.ToUniversalTime().Ticks == ticks ? "same" : "other"; } catch { return "unknown"; }
  }
  // 只结束记下的那个进程：先拿住句柄（PID 在句柄关闭前不会被复用），再在同一个对象上核出生时间并结束。
  public static string KillSame(int pid, long ticks) {
    Process process;
    try { process = Process.GetProcessById(pid); } catch (ArgumentException) { return "gone"; } catch { return "unknown"; }
    try {
      IntPtr pinned = process.Handle;
      if (process.StartTime.ToUniversalTime().Ticks != ticks) return "other";
      process.Kill();
      return "killed";
    } catch { return "unknown"; }
  }
  public static string Session(int pid) {
    return Process.GetProcessById(pid).SessionId.ToString();
  }
}
"@
[Console]::Out.WriteLine("ready")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Split(' ')
  try {
    switch ($parts[0]) {
      'tree' { [Console]::Out.WriteLine([AtmBudgetProbe]::Tree([int]$parts[1])) }
      'close' { [Console]::Out.WriteLine([AtmBudgetProbe]::Close([long]$parts[1])) }
      'session' { [Console]::Out.WriteLine([AtmBudgetProbe]::Session([int]$parts[1])) }
      'alive' { [Console]::Out.WriteLine([AtmBudgetProbe]::Alive([int]$parts[1], [long]$parts[2])) }
      'killsame' { [Console]::Out.WriteLine([AtmBudgetProbe]::KillSame([int]$parts[1], [long]$parts[2])) }
      default { [Console]::Out.WriteLine('null') }
    }
  } catch { [Console]::Out.WriteLine('null') }
}
`;
