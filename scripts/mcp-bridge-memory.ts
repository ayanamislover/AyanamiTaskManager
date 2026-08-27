import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { freemem, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MCP_STDIO_FILENAME } from "../apps/desktop/src/mcp-launch.js";
import { configuredBridgeLaunch, type McpProfile } from "./mcp-bridge-launch.js";

const run = promisify(execFile);

/**
 * 量每个 MCP stdio bridge 的真实内存代价。
 *
 * 起因是一条 CRITICAL 记录：10 个空闲 bridge 合计 Working Set 1032.38 MiB、均值 103.24 MiB。
 * 但 **Working Set 会把映射同一份可执行映像的共享页在每个进程上各计一遍**——十个进程共用
 * 一份 Electron 映像时，把十份 Working Set 相加等于把那份映像算了十次。所以那个数字既不能
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
 * 全程不调用 WMI/CIM（AGENTS.md 明令禁止），进程指标只点名读 Get-Process 的标量属性。
 *
 * 用法：
 *   pnpm exec tsx scripts/mcp-bridge-memory.ts                 按客户端实际配置量 1 与 10
 *   pnpm exec tsx scripts/mcp-bridge-memory.ts --bridges 15
 *   pnpm exec tsx scripts/mcp-bridge-memory.ts --profile memory
 *   pnpm exec tsx scripts/mcp-bridge-memory.ts --runtime node  拿本机 node 当参照下限
 *   pnpm exec tsx scripts/mcp-bridge-memory.ts --json out.json
 *
 * 需要 ATM 正在运行：桥接脚本要读 runtime/daemon.json 才能干活。
 */

type Sample = { pid: number; workingSet: number; privateBytes: number };
type Round = {
  bridges: number;
  total: Sample;
  perProcess: Sample[];
  /** 拉起这批 bridge 让系统少掉的可用物理内存。这是唯一不受共享页重复计数影响的口径。 */
  systemCost: number;
};

const MIB = 1024 * 1024;

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function dataDir(): string {
  const explicit = process.env.ATM_DATA_DIR;
  if (explicit) return explicit;
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(local, "AyanamiTaskManager");
}

/**
 * 默认量的是**客户端配置里真正写着的那条命令**，不是我们自己拼的。
 * 之前吃过一次亏：烟测证明了"桥能跑"，却从没证明过"配置里写的那条路径能跑"。
 */
function configuredLaunch(profile: McpProfile): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return configuredBridgeLaunch({ profile, dataDir: dataDir() });
}

/** 参照下限：用本机的普通 node 跑同一份桥接脚本，看不带 Electron 能到多少。 */
function nodeLaunch(profile: McpProfile): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: process.execPath,
    args: [join(dataDir(), MCP_STDIO_FILENAME), "--profile", profile],
    env: {},
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function measure(pids: number[]): Promise<Sample[]> {
  // 只用 Get-Process 的标量属性。**不调用 WMI/CIM**（AGENTS.md 明令禁止），
  // 也不把 Process 对象整个交给 ConvertTo-Json——逐字段点名读进扁平 DTO 再序列化。
  // 代价是拿不到私有工作集（那个只有性能计数器有）；不要紧，系统可用内存的前后差
  // 才是这里真正要的口径，Private Bytes 已经够界定上界。
  const script = `
    $ids = @(${pids.join(",")})
    $ids | ForEach-Object {
      $procId = $_
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($p) {
        [pscustomobject]@{
          pid = [int]$p.Id
          workingSet = [int64]$p.WorkingSet64
          privateBytes = [int64]$p.PrivateMemorySize64
        }
      }
    } | ConvertTo-Json -Compress
  `;
  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  // Windows PowerShell 5.1 没有 -AsArray：单个对象出来就不是数组，在这里归一，
  // 不要为了输出形状去要求机器上装 pwsh。
  const parsed: unknown = JSON.parse(stdout.trim() || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]) as Sample[];
}

type Bridge = { child: ChildProcess; stderr: string[] };

function startBridge(
  launch: { command: string; args: string[]; env: Record<string, string> },
  index: number,
): Bridge {
  const child = spawn(launch.command, launch.args, {
    env: { ...process.env, ...launch.env },
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
 * 只按 PID 收尾。**绝对不能按镜像名杀**——bridge 与 ATM 桌面应用是同一个
 * AyanamiTaskManager.exe，按名字杀会把用户正在用的应用一起关掉。
 */
function stopBridges(bridges: Bridge[]): void {
  for (const bridge of bridges) {
    if (bridge.child.exitCode === null) bridge.child.kill();
  }
}

function sum(samples: Sample[]): Sample {
  return samples.reduce(
    (total, sample) => ({
      pid: 0,
      workingSet: total.workingSet + sample.workingSet,
      privateBytes: total.privateBytes + sample.privateBytes,
    }),
    { pid: 0, workingSet: 0, privateBytes: 0 },
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
  launch: { command: string; args: string[]; env: Record<string, string> },
  bridges: number,
  settleMs: number,
): Promise<Round> {
  const started: Bridge[] = [];
  const availableBefore = availableBytes();
  try {
    for (let index = 0; index < bridges; index += 1) started.push(startBridge(launch, index));
    await delay(settleMs);
    const dead = started.filter((bridge) => bridge.child.exitCode !== null);
    if (dead.length > 0) {
      throw new Error(
        `${dead.length} 个 bridge 提前退出（ATM 没在运行？）：${dead[0]!.stderr.join("").slice(0, 300)}`,
      );
    }
    const pids = started.map((bridge) => bridge.child.pid!).filter((pid) => Number.isInteger(pid));
    const perProcess = await measure(pids);
    if (perProcess.length !== pids.length) {
      throw new Error(`量到 ${perProcess.length} 个进程，实际拉起 ${pids.length} 个`);
    }
    return {
      bridges,
      total: sum(perProcess),
      perProcess,
      systemCost: availableBefore - availableBytes(),
    };
  } finally {
    stopBridges(started);
  }
}

function mib(bytes: number): string {
  return `${(bytes / MIB).toFixed(2)} MiB`;
}

async function main(): Promise<void> {
  const bridges = Number(argValue("bridges", "10"));
  if (!Number.isInteger(bridges) || bridges < 2) throw new Error("--bridges 至少为 2");
  const requestedProfile = argValue("profile", "core");
  if (requestedProfile !== "core" && requestedProfile !== "memory")
    throw new Error("--profile 只接受 core 或 memory");
  const profile: McpProfile = requestedProfile;
  const runtime = argValue("runtime", "configured");
  const base = runtime === "node" ? nodeLaunch(profile) : configuredLaunch(profile);
  // --node-args 用来试 V8 调参：每个 bridge 的边际成本基本就是 Node 自己的堆与启动开销，
  // 换运行时省不掉，调堆参数才可能省。放在脚本参数里是为了让"省了多少"可复算。
  const nodeArgs = argValue("node-args", "")
    .split(" ")
    .map((value) => value.trim())
    .filter(Boolean);
  const launch = { ...base, args: [...nodeArgs, ...base.args] };
  const settleMs = Number(argValue("settle-ms", "6000"));

  console.log(`运行时 : ${runtime} (${profile})`);
  console.log(`command: ${launch.command}`);
  console.log(`args   : ${launch.args.join(" ")}`);
  console.log("");

  // 先量 1 个再量 N 个：两轮相减才拿得到边际。单量一轮只能得到均值，
  // 而均值里含着那份被所有进程共用的映像，会把可省的量算大。
  const single = await round(launch, 1, settleMs);
  await delay(1500);
  // 系统可用内存是全机共享的量，机器上任何别的程序动一下都会盖过信号——实测同一
  // 配置连跑四轮出现过 −1408 MiB 和 +1065 MiB 这种明显是噪声的值。所以这一口径
  // 必须多轮取中位数并报离散度；单轮数字不许拿来下结论。
  const repeats = Math.max(1, Number(argValue("repeat", "5")));
  const rounds: Round[] = [];
  for (let index = 0; index < repeats; index += 1) {
    if (index > 0) await delay(2000);
    rounds.push(await round(launch, bridges, settleMs));
  }
  const many = rounds[rounds.length - 1]!;
  const systemCosts = rounds.map((entry) => entry.systemCost).sort((left, right) => left - right);
  const systemMedian = systemCosts[Math.floor(systemCosts.length / 2)]!;
  const systemSpread = systemCosts[systemCosts.length - 1]! - systemCosts[0]!;

  const marginal = {
    workingSet: (many.total.workingSet - single.total.workingSet) / (bridges - 1),
    privateBytes: (many.total.privateBytes - single.total.privateBytes) / (bridges - 1),
  };

  const rows = [
    ["", "Working Set", "Private Bytes"],
    [`1 个 bridge`, mib(single.total.workingSet), mib(single.total.privateBytes)],
    [`${bridges} 个合计`, mib(many.total.workingSet), mib(many.total.privateBytes)],
    [
      `${bridges} 个均值`,
      mib(many.total.workingSet / bridges),
      mib(many.total.privateBytes / bridges),
    ],
    ["边际（每多一个）", mib(marginal.workingSet), mib(marginal.privateBytes)],
  ];
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => [...row[column]!].length)),
  );
  for (const row of rows) {
    console.log(row.map((cell, column) => cell.padEnd(widths[column]!)).join("  "));
  }

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
    console.log(`  ⚠ 极差大于中位数，本次系统口径不可用于下结论；换到空闲机器或加大 --repeat。`);
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

  const jsonPath = argValue("json", "");
  if (jsonPath) {
    writeFileSync(
      jsonPath,
      `${JSON.stringify({ runtime, profile, command: launch.command, bridges, single, rounds, marginal, systemMedian, systemSpread }, null, 2)}\n`,
      "utf8",
    );
    console.log(`\n已写入 ${jsonPath}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
