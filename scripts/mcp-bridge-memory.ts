import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  MCP_SHIM_FILENAME,
  MCP_STDIO_FILENAME,
  mcpNodeBridgeLaunch,
  type McpProfile,
} from "../apps/desktop/src/mcp-launch.js";
import {
  assertSandboxDataDir,
  delay,
  killProcessTree,
  prepareSandbox,
  smokeExecutable,
  startSmokeHost,
  stopSmokeHost,
  waitForRuntime,
  waitUntil,
  snapshotLoginItems,
  exited,
} from "./smoke-host.js";
import { withPowerShellScratch } from "./powershell-scratch.js";

const run = promisify(execFile);

/**
 * 量每个 MCP stdio bridge 的真实内存代价。
 *
 * 起因是一条 CRITICAL 记录：10 个空闲 bridge 合计 Working Set 1032.38 MiB、均值 103.24 MiB。
 * 但 **Working Set 会把映射同一份可执行映像的共享页在每个进程上各计一遍**——十个进程共用
 * 一份映像时，把十份 Working Set 相加等于把那份映像算了十次。所以那个数字既不能
 * 用来判断"省得下来多少"，也不能用来选方案。
 *
 * 这里取三个口径，并且以**边际**而不是均值下结论：
 *
 *   Working Set   进程当前占用的物理内存，含共享页 —— 相加会重复计数，只用来展示这个偏差有多大
 *   Private Bytes 进程已提交的私有虚拟内存，不含共享 —— 上界
 *   系统可用内存差 拉起前后 os.freemem() 的落差 —— 唯一两头都不偏的口径，结论以它为准
 *
 * 边际成本 = (N 个 bridge 的总量 − 1 个 bridge 的总量) / (N − 1)。
 * 只有这个数才回答"再接一个客户端要多花多少"。
 *
 * 一个 bridge 的代价按它的**整棵进程树**算：原生 shim 是一个进程；宿主的 --mcp-stdio 与
 * Electron 旧配置那条命令是宿主再拉一个随包 Node，两个进程都算进去。
 *
 * 全程在沙箱里：拉起一个便携的 smoke 宿主（数据根在 output/ 下），bridge 都指向这个数据根。
 * 不读任何真实的 Agent 客户端配置，也不碰真实安装与真实数据根。
 *
 * 全程不调用 WMI/CIM，进程树用 Toolhelp32 快照，指标点名读 Process 的标量属性。
 *
 * 用法：
 *   pnpm exec tsx scripts/mcp-bridge-memory.ts                   原生 atm-mcp.exe，量 1 与 10
 *   pnpm exec tsx scripts/mcp-bridge-memory.ts --bridges 15
 *   pnpm exec tsx scripts/mcp-bridge-memory.ts --profile memory
 *   pnpm exec tsx scripts/mcp-bridge-memory.ts --runtime host     宿主 --mcp-stdio（shim 缺失时的回落）
 *   pnpm exec tsx scripts/mcp-bridge-memory.ts --runtime legacy   Electron 1.x 写进配置的旧命令
 *   pnpm exec tsx scripts/mcp-bridge-memory.ts --runtime node     拿本机 node 跑同一份桥接脚本当参照
 *   pnpm exec tsx scripts/mcp-bridge-memory.ts --json output/bridge-memory.json
 *
 * 被测的是 package-native --smoke 产出的便携版本目录（ATM_PACKAGED_EXE 可改指）。
 */

/** 一个 bridge 整棵进程树的合计；names 是树里各进程的映像名（含系统为控制台程序配的 conhost）。 */
type Sample = {
  pid: number;
  workingSet: number;
  privateBytes: number;
  processes: number;
  names?: string;
};
type Round = {
  bridges: number;
  total: Sample;
  perProcess: Sample[];
  /** 拉起这批 bridge 让系统少掉的可用物理内存。这是唯一不受共享页重复计数影响的口径。 */
  systemCost: number;
};
type Launch = { command: string; args: string[]; env: Record<string, string> };

const MIB = 1024 * 1024;

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const executable = smokeExecutable();
const appDir = dirname(executable);

/** 原生 shim：版本目录 resources 里那一份，和写进 Agent 配置的是同一个文件。 */
function shimLaunch(profile: McpProfile): Launch {
  const command = join(appDir, "resources", MCP_SHIM_FILENAME);
  if (!existsSync(command)) throw new Error(`烟测构建里找不到 ${MCP_SHIM_FILENAME}：${command}`);
  return { command, args: ["--profile", profile], env: {} };
}

/** shim 不在时配置回落到的入口：宿主自己的 --mcp-stdio，宿主再用随包 Node 跑桥接脚本。 */
function hostLaunch(profile: McpProfile): Launch {
  return { command: executable, args: ["--mcp-stdio", "--profile", profile], env: {} };
}

/**
 * Electron 1.x 写进 Agent 配置的旧命令（ELECTRON_RUN_AS_NODE + 数据根的 mcp-stdio.cjs）。
 * 迁移后客户端仍可能握着它直到重启；原生宿主认出它并转给同一个 Node 桥。
 */
function legacyLaunch(dataDir: string): (profile: McpProfile) => Launch {
  return (profile) => {
    const launch = mcpNodeBridgeLaunch({ execPath: executable, dataDir });
    return { ...launch, args: [...launch.args, "--profile", profile] };
  };
}

/** 参照下限：用本机的普通 node 跑数据根里同一份桥接脚本。 */
function nodeLaunch(dataDir: string): (profile: McpProfile) => Launch {
  return (profile) => ({
    command: process.execPath,
    args: [join(dataDir, MCP_STDIO_FILENAME), "--profile", profile],
    env: {},
  });
}

/**
 * 每个根 PID 连同它的子孙一起量。父子关系取 Toolhelp32 快照；子进程必须晚于父进程启动，
 * 免得 PID 被复用后把无关进程算进来。只读 Process 的标量属性，不调用 WMI/CIM。
 */
const PROCESS_TREE_PROBE = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class AtmProcessTree {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Entry {
    public uint Size; public uint Usage; public uint Pid; public IntPtr Heap; public uint Module;
    public uint Threads; public uint Parent; public int Priority; public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe;
  }
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  private static DateTime Started(int pid) {
    try { return Process.GetProcessById(pid).StartTime; } catch { return DateTime.MaxValue; }
  }
  public static string Measure(int[] roots) {
    var children = new Dictionary<int, List<int>>();
    var names = new Dictionary<int, string>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    var entry = new Entry { Size = (uint)Marshal.SizeOf(typeof(Entry)) };
    for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
      List<int> list;
      if (!children.TryGetValue((int)entry.Parent, out list)) children[(int)entry.Parent] = list = new List<int>();
      list.Add((int)entry.Pid);
      names[(int)entry.Pid] = entry.Exe;
    }
    CloseHandle(snapshot);
    var output = new List<string>();
    foreach (int root in roots) {
      var tree = new List<int> { root };
      for (int index = 0; index < tree.Count; index++) {
        List<int> list;
        if (!children.TryGetValue(tree[index], out list)) continue;
        DateTime parentStarted = Started(tree[index]);
        foreach (int child in list) if (child != tree[index] && Started(child) >= parentStarted && Started(child) != DateTime.MaxValue) tree.Add(child);
      }
      long workingSet = 0, privateBytes = 0; int alive = 0; var exes = new List<string>();
      foreach (int pid in tree) {
        try {
          var process = Process.GetProcessById(pid);
          workingSet += process.WorkingSet64; privateBytes += process.PrivateMemorySize64; alive++;
          string exe; if (names.TryGetValue(pid, out exe)) exes.Add(exe);
        } catch { }
      }
      if (alive == 0) continue;
      output.Add("{\\"pid\\":" + root + ",\\"workingSet\\":" + workingSet + ",\\"privateBytes\\":" + privateBytes + ",\\"processes\\":" + alive + ",\\"names\\":\\"" + string.Join(" ", exes.ToArray()) + "\\"}");
    }
    return "[" + string.Join(",", output.ToArray()) + "]";
  }
}
"@
`;

async function measure(pids: number[]): Promise<Sample[]> {
  const { stdout } = await withPowerShellScratch((env) =>
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `${PROCESS_TREE_PROBE}[AtmProcessTree]::Measure(@(${pids.join(",")}))`,
      ],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true, env },
    ),
  );
  return JSON.parse(stdout.trim() || "[]") as Sample[];
}

type Bridge = { child: ChildProcess; stderr: string[] };

function startBridge(launch: Launch, env: NodeJS.ProcessEnv, index: number): Bridge {
  const child = spawn(launch.command, launch.args, {
    env: { ...env, ...launch.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
    if (stderr.length > 10) stderr.shift();
  });
  child.stdout?.resume();
  child.stdin?.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: `bridge-memory-${index}`, version: "1.0.0" },
      },
    })}\n`,
  );
  return { child, stderr };
}

/**
 * 先关 stdin 让 bridge 自己退（宿主转给 Node 的那种要等 Node 退出才退），到点还在就按
 * **自己拉起的 PID** 结束进程树。绝对不按镜像名杀——宿主的 --mcp-stdio 与用户正在用的
 * 应用是同一个 AyanamiTaskManager.exe。
 */
async function stopBridges(bridges: Bridge[]): Promise<void> {
  for (const bridge of bridges) bridge.child.stdin?.end();
  await waitUntil(
    async () => (bridges.every((bridge) => exited(bridge.child)) ? true : null),
    5_000,
    "bridge 退出",
  ).catch(() => undefined);
  for (const bridge of bridges)
    if (!exited(bridge.child) && bridge.child.pid !== undefined) killProcessTree(bridge.child.pid);
}

function sum(samples: Sample[]): Sample {
  return samples.reduce(
    (total, sample) => ({
      pid: 0,
      workingSet: total.workingSet + sample.workingSet,
      privateBytes: total.privateBytes + sample.privateBytes,
      processes: total.processes + sample.processes,
    }),
    { pid: 0, workingSet: 0, privateBytes: 0, processes: 0 },
  );
}

/**
 * 系统可用物理内存。把 Working Set 相加会把共享页按进程各计一遍，Private Bytes 又只是
 * 已提交的虚拟内存、不等于实际驻留；只有"拉起前后系统少了多少"这一个口径两头都不偏。
 *
 * 用 Node 自己的 os.freemem()，不走 WMI 也不走 PowerShell。
 */
function availableBytes(): number {
  return freemem();
}

async function round(
  launch: Launch,
  env: NodeJS.ProcessEnv,
  bridges: number,
  settleMs: number,
): Promise<Round> {
  const started: Bridge[] = [];
  const availableBefore = availableBytes();
  try {
    for (let index = 0; index < bridges; index += 1) started.push(startBridge(launch, env, index));
    await delay(settleMs);
    const dead = started.filter((bridge) => exited(bridge.child));
    if (dead.length > 0) {
      throw new Error(
        `${dead.length} 个 bridge 提前退出：${dead[0]!.stderr.join("").slice(0, 300)}`,
      );
    }
    const pids = started.map((bridge) => bridge.child.pid!).filter((pid) => Number.isInteger(pid));
    const perProcess = await measure(pids);
    if (perProcess.length !== pids.length) {
      throw new Error(`量到 ${perProcess.length} 个 bridge，实际拉起 ${pids.length} 个`);
    }
    return {
      bridges,
      total: sum(perProcess),
      perProcess,
      systemCost: availableBefore - availableBytes(),
    };
  } finally {
    await stopBridges(started);
  }
}

function mib(bytes: number): string {
  return `${(bytes / MIB).toFixed(2)} MiB`;
}

async function main(): Promise<void> {
  const bridges = Number(argValue("bridges", "10"));
  if (!Number.isInteger(bridges) || bridges < 2) throw new Error("--bridges 至少为 2");
  const requestedProfile = argValue("profile", "core");
  if (
    requestedProfile !== "core" &&
    requestedProfile !== "memory" &&
    requestedProfile !== "actions"
  )
    throw new Error("--profile 只接受 core、memory 或 actions");
  const profile: McpProfile = requestedProfile;
  const runtime = argValue("runtime", "shim");
  const sandbox = await prepareSandbox("bridge-memory");
  const launchers: Record<string, (profile: McpProfile) => Launch> = {
    shim: shimLaunch,
    host: hostLaunch,
    legacy: legacyLaunch(sandbox.dataDir),
    node: nodeLaunch(sandbox.dataDir),
  };
  const launcher = launchers[runtime];
  if (!launcher) throw new Error(`--runtime 只接受 ${Object.keys(launchers).join("、")}`);
  const base = launcher(profile);
  // --node-args 用来试 V8 调参：只对 --runtime node 有意义（其余入口的 Node 由宿主拉起）。
  const nodeArgs = argValue("node-args", "")
    .split(" ")
    .map((value) => value.trim())
    .filter(Boolean);
  if (nodeArgs.length > 0 && runtime !== "node")
    throw new Error("--node-args 只适用于 --runtime node");
  const launch = { ...base, args: [...nodeArgs, ...base.args] };
  const settleMs = Number(argValue("settle-ms", "6000"));
  const jsonPath = argValue("json", "");
  // 报告也只落在 output/ 下。
  let reportPath = "";
  try {
    reportPath = jsonPath ? assertSandboxDataDir(jsonPath) : "";
  } catch (error) {
    throw new Error(`--json 只能写到 output/ 下：${String(error)}`, { cause: error });
  }

  console.log(`运行时 : ${runtime} (${profile})`);
  console.log(`command: ${launch.command}`);
  console.log(`args   : ${launch.args.join(" ")}`);
  console.log(`数据根 : ${sandbox.dataDir}`);
  console.log("");

  // 先拍 Run 快照再启动宿主：读不到就什么都不启动。
  const loginItems = snapshotLoginItems();
  const host = startSmokeHost({ executable, dataDir: sandbox.dataDir, env: sandbox.env });
  await loginItems.restoreAfter(async () => {
    try {
      await waitForRuntime(host);
      if (runtime === "legacy" || runtime === "node")
        await waitUntil(
          async () => (existsSync(join(sandbox.dataDir, MCP_STDIO_FILENAME)) ? true : null),
          10_000,
          "数据根里的桥接脚本",
        );

      // 先量 1 个再量 N 个：两轮相减才拿得到边际。单量一轮只能得到均值，
      // 而均值里含着那份被所有进程共用的映像，会把可省的量算大。
      const single = await round(launch, sandbox.env, 1, settleMs);
      await delay(1500);
      // 系统可用内存是全机共享的量，机器上任何别的程序动一下都会盖过信号——实测同一
      // 配置连跑四轮出现过 −1408 MiB 和 +1065 MiB 这种明显是噪声的值。所以这一口径
      // 必须多轮取中位数并报离散度；单轮数字不许拿来下结论。
      const repeats = Math.max(1, Number(argValue("repeat", "5")));
      const rounds: Round[] = [];
      for (let index = 0; index < repeats; index += 1) {
        if (index > 0) await delay(2000);
        rounds.push(await round(launch, sandbox.env, bridges, settleMs));
      }
      const many = rounds[rounds.length - 1]!;
      const systemCosts = rounds
        .map((entry) => entry.systemCost)
        .sort((left, right) => left - right);
      const systemMedian = systemCosts[Math.floor(systemCosts.length / 2)]!;
      const systemSpread = systemCosts[systemCosts.length - 1]! - systemCosts[0]!;

      const marginal = {
        workingSet: (many.total.workingSet - single.total.workingSet) / (bridges - 1),
        privateBytes: (many.total.privateBytes - single.total.privateBytes) / (bridges - 1),
      };

      const rows = [
        ["", "Working Set", "Private Bytes", "进程数"],
        [
          `1 个 bridge`,
          mib(single.total.workingSet),
          mib(single.total.privateBytes),
          String(single.total.processes),
        ],
        [
          `${bridges} 个合计`,
          mib(many.total.workingSet),
          mib(many.total.privateBytes),
          String(many.total.processes),
        ],
        [
          `${bridges} 个均值`,
          mib(many.total.workingSet / bridges),
          mib(many.total.privateBytes / bridges),
          "",
        ],
        ["边际（每多一个）", mib(marginal.workingSet), mib(marginal.privateBytes), ""],
      ];
      const widths = rows[0]!.map((_, column) =>
        Math.max(...rows.map((row) => [...row[column]!].length)),
      );
      for (const row of rows) {
        console.log(row.map((cell, column) => cell.padEnd(widths[column]!)).join("  "));
      }
      console.log(`一个 bridge 的进程树：${single.perProcess[0]?.names ?? "?"}`);

      console.log("");
      console.log(
        `系统可用内存差（${repeats} 轮）：${systemCosts.map((value) => mib(value)).join(" / ")}`,
      );
      console.log(
        `  中位数 ${mib(systemMedian)}，合每个 ${mib(systemMedian / bridges)}；极差 ${mib(systemSpread)}。`,
      );
      // 离散度超过中位数本身，说明这台机器上别的负载盖过了信号。宁可说"这轮量不准"，
      // 也不能把一个噪声数字当成结论——尤其当它要用来推翻已有记录时。
      if (systemSpread > Math.abs(systemMedian)) {
        console.log(
          `  ⚠ 极差大于中位数，本次系统口径不可用于下结论；换到空闲机器或加大 --repeat。`,
        );
      }
      const inflation = many.total.workingSet / Math.max(systemMedian, 1);
      if (systemSpread <= Math.abs(systemMedian)) {
        console.log(
          `同一批进程的 Working Set 合计 ${mib(many.total.workingSet)} 是系统实测的 ${inflation.toFixed(1)} 倍——` +
            `同一份可执行映像被每个进程各计了一遍。`,
        );
      }
      console.log(
        `
结论口径：Private Bytes 的边际（${mib(marginal.privateBytes)}/bridge）噪声最低，优先用它；` +
          `Working Set 之和只用于展示重复计数有多大，**不得用来比较两种运行时**。`,
      );

      if (reportPath) {
        writeFileSync(
          reportPath,
          `${JSON.stringify({ runtime, profile, command: launch.command, bridges, single, rounds, marginal, systemMedian, systemSpread }, null, 2)}\n`,
          "utf8",
        );
        console.log(`\n已写入 ${reportPath}`);
      }
    } finally {
      if (!(await stopSmokeHost(host)))
        console.error(`烟测宿主没有按 --smoke-quit 干净退出：${host.stderr.join("")}`);
    }
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
