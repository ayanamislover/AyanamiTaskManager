/**
 * 预算测量用的常驻 PowerShell 进程探针（Toolhelp32 进程树 + 出生身份 + 标量查询）。
 * 单独成模块、无副作用：budget-measure.ts 用它，测试也能直接真编译、真跑。
 *
 * 分工：C# 只采集原始数据（快照里的候选、各自的出生时间与内存，句柄拿住时读）；谁算这棵树的
 * 成员、哪些查不了，由下面的纯函数 buildProcessTree 判定，可以直接拿竞态数据做回归。
 */
export type ProcessRow = {
  pid: number;
  ppid: number;
  exe: string;
  /** 读不到时为 -1，并列在 ProcessTree.unmeasured。 */
  ws: number;
  priv: number;
  /** 出生时间（.NET ticks，UTC）：与树成员身份一起取，之后按它认人。 */
  ticks: string;
};

export type ProcessTree = {
  /** 认得出身份的成员（含根）。 */
  rows: ProcessRow[];
  /** 查不了身份的候选 PID（含根）：树不完整，不能据此声称子孙都已退出。 */
  unknown: number[];
  /** 身份确认、但内存读不到的成员 PID：量内存时不出样本。 */
  unmeasured: number[];
};

/** 探针 Tree 的原始输出。 */
export type RawProcessTree = {
  /**
   * 拍快照之前取的时间（ticks，UTC）。快照里的进程都在快照完成前出生；出生晚于它的，无法证明
   * 就是快照里的那一个。
   */
  bound: string;
  members: Array<{
    pid: number;
    ppid: number;
    exe: string;
    state: string;
    ticks: string | null;
    ws: number | null;
    priv: number | null;
  }>;
};

/**
 * 从快照候选里认出以 root 为根的进程树：
 * - 已退出（gone）的不算成员；
 * - 查不了身份的、出生晚于快照前界限的（分不清是快照期间合法出生的子孙，还是 PID 被复用后
 *   的别人）记为 unknown，不当成员也不当已退出；
 * - 出生早于父进程的不是它的子孙（父 PID 被复用过），排除；
 * - unknown 与被排除者的下层不再展开。根查不了时整棵树都是 unknown。
 */
export function buildProcessTree(raw: RawProcessTree, root: number): ProcessTree {
  const bound = BigInt(raw.bound);
  const tree: ProcessTree = { rows: [], unknown: [], unmeasured: [] };
  const births = new Map<number, bigint>();
  const order: number[] = [];
  const accept = (member: RawProcessTree["members"][number], parentBirth: bigint | null) => {
    if (member.state === "gone") return;
    if (member.state !== "ok" || member.ticks === null) {
      tree.unknown.push(member.pid);
      return;
    }
    const birth = BigInt(member.ticks);
    if (birth > bound) {
      tree.unknown.push(member.pid);
      return;
    }
    if (parentBirth !== null && birth < parentBirth) return;
    tree.rows.push({
      pid: member.pid,
      ppid: member.ppid,
      exe: member.exe,
      ws: member.ws ?? -1,
      priv: member.priv ?? -1,
      ticks: member.ticks,
    });
    if (member.ws === null || member.priv === null) tree.unmeasured.push(member.pid);
    births.set(member.pid, birth);
    order.push(member.pid);
  };
  const rootMember = raw.members.find((member) => member.pid === root);
  if (rootMember) accept(rootMember, null);
  for (let index = 0; index < order.length; index += 1) {
    const parent = order[index]!;
    for (const member of raw.members)
      if (member.ppid === parent && member.pid !== parent && !births.has(member.pid))
        accept(member, births.get(parent)!);
  }
  return tree;
}

/** 树查全了：整次查询成功，且没有查不了身份的候选（含根）。 */
export function treeComplete(tree: ProcessTree | null): tree is ProcessTree {
  return tree !== null && tree.unknown.length === 0;
}

/** alive 的回答里只有这两种算「记下的那个进程已经不在」；其余（含协议错误）都是查不了。 */
export const EXITED_STATES: ReadonlySet<string> = new Set(["gone", "other"]);

/** 宿主退出后的结论：只有树查全了、且每个子孙都明确 gone / other，才算确认全部退出。 */
export function descendantsExited(tree: ProcessTree | null, states: readonly string[]): boolean {
  return treeComplete(tree) && states.every((state) => EXITED_STATES.has(state));
}

/**
 * 每轮保存退出证据之后调用：没确认子孙全部退出，就停止后续轮次——未确认退出的 WebView2
 * 可能还占着这一轮的用户数据目录，下一轮不能刷新、复用它。不结束身份未知的进程。
 */
export function requireExitConfirmed(label: string, quit: { confirmed: boolean }): void {
  if (!quit.confirmed)
    throw new Error(`${label}：宿主的子孙进程没能确认全部退出，停止后续轮次（不复用数据目录）`);
}

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
  // 只采集，不判定（判定在 TS 的 buildProcessTree）。bound 取在拍快照之前。候选是快照里以 root
  // 为根、按父 PID 连起来的进程；每个都拿住句柄，在同一个对象上读出生时间与内存。
  // 整次查询失败由调用方的 catch 输出 null。
  public static string Tree(int root) {
    long bound = DateTime.UtcNow.Ticks;
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("CreateToolhelp32Snapshot");
    var pinned = new List<Process>();
    try {
      var children = new Dictionary<int, List<int>>();
      var names = new Dictionary<int, string>();
      var parents = new Dictionary<int, int>();
      var entry = new Entry { Size = (uint)Marshal.SizeOf(typeof(Entry)) };
      for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
        List<int> list;
        if (!children.TryGetValue((int)entry.Parent, out list)) children[(int)entry.Parent] = list = new List<int>();
        list.Add((int)entry.Pid);
        parents[(int)entry.Pid] = (int)entry.Parent;
        names[(int)entry.Pid] = entry.Exe;
      }
      var candidates = new List<int>();
      var seen = new Dictionary<int, bool>();
      if (names.ContainsKey(root)) { candidates.Add(root); seen[root] = true; }
      for (int index = 0; index < candidates.Count; index++) {
        List<int> list;
        if (!children.TryGetValue(candidates[index], out list)) continue;
        foreach (int child in list) if (!seen.ContainsKey(child)) { seen[child] = true; candidates.Add(child); }
      }
      var members = new List<string>();
      foreach (int pid in candidates) {
        Process process;
        DateTime birth;
        string state = Pin(pid, out process, out birth);
        string ticks = "null", ws = "null", priv = "null";
        if (state == "ok") {
          pinned.Add(process);
          ticks = "\\"" + birth.Ticks + "\\"";
          try {
            string workingSet = process.WorkingSet64.ToString();
            string privateBytes = process.PrivateMemorySize64.ToString();
            ws = workingSet;
            priv = privateBytes;
          } catch { }
        }
        members.Add("{\\"pid\\":" + pid + ",\\"ppid\\":" + parents[pid] + ",\\"exe\\":\\"" + names[pid] + "\\",\\"state\\":\\"" + state + "\\",\\"ticks\\":" + ticks + ",\\"ws\\":" + ws + ",\\"priv\\":" + priv + "}");
      }
      return "{\\"bound\\":\\"" + bound + "\\",\\"members\\":[" + string.Join(",", members.ToArray()) + "]}";
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
