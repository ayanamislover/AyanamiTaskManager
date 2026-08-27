import { execFile } from "node:child_process";
import { basename, extname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type McpBridgeObservation = {
  sampledAt: string;
  metric: "PRIVATE_BYTES";
  totalPrivateBytes: number;
  bridges: Array<{
    pid: number;
    ownerPid: number | null;
    ownerName: string;
    startedAt: string;
    privateBytes: number;
  }>;
};

type Execute = (file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>;

type BridgeProcess = {
  pid: number;
  startedAt: string;
  privateBytes: number;
};

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
}

function finiteInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseBridgeProcesses(stdout: string): BridgeProcess[] {
  const parsed: unknown = JSON.parse(stdout.trim() || "[]");
  return asArray(parsed).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const pid = finiteInteger(row.pid);
    const privateBytes = finiteInteger(row.privateBytes);
    const startedAt = typeof row.startedAt === "string" ? row.startedAt : "";
    return pid === null || privateBytes === null || !startedAt
      ? []
      : [{ pid, privateBytes, startedAt }];
  });
}

function parseParentProcesses(stdout: string): Map<number, string> {
  const parsed: unknown = JSON.parse(stdout.trim() || "[]");
  const parents = new Map<number, string>();
  for (const value of asArray(parsed)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const pid = finiteInteger(row.pid);
    if (pid !== null && typeof row.name === "string" && row.name.trim()) {
      parents.set(pid, row.name.trim());
    }
  }
  return parents;
}

function supportedAgentProcess(name: string): boolean {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/\.exe$/u, "");
  // Codex 以 codex.exe 启动 stdio server；Claude Desktop 与 Claude Code 在 Windows
  // 上的 direct parent 均为 claude.exe。只接受这两个直接父进程，stable exe 路径本身
  // 只是候选集，不能把同路径启动的桌面 main / renderer / GPU helper 算成 bridge。
  return normalized === "codex" || normalized === "claude";
}

function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  cells.push(value);
  return cells;
}

function parentPidByBridge(stdout: string): Map<number, number> {
  const rows = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map(parseCsvRow);
  if (rows.length < 2) return new Map();
  const headers = rows[0]!;
  const values = rows[1]!;
  const instances = new Map<string, { pid?: number; parentPid?: number }>();
  for (let index = 1; index < Math.min(headers.length, values.length); index += 1) {
    const header = headers[index]!;
    const instance = header.match(/\(([^()]*)\)\\/u)?.[1];
    const numeric = finiteInteger(Math.round(Number(values[index])));
    if (!instance || numeric === null) continue;
    const entry = instances.get(instance) ?? {};
    if (/\\Creating Process ID$/iu.test(header)) entry.parentPid = numeric;
    else if (/\\ID Process$/iu.test(header)) entry.pid = numeric;
    instances.set(instance, entry);
  }
  const result = new Map<number, number>();
  for (const entry of instances.values()) {
    if (entry.pid !== undefined && entry.parentPid !== undefined) {
      result.set(entry.pid, entry.parentPid);
    }
  }
  return result;
}

async function execute(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(file, args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

export function assertPrivateBytesOnly(source: string): void {
  const forbidden = new RegExp(["working", "set"].join("[\\s_-]*"), "iu");
  if (forbidden.test(source))
    throw new Error("PRIVATE_BYTES_ONLY: shared pages must not be summed");
}

export async function observeMcpBridges(input: {
  bridgeCommand: string;
  now?: () => Date;
  execute?: Execute;
}): Promise<McpBridgeObservation> {
  const run = input.execute ?? execute;
  const expectedPath = powershellLiteral(input.bridgeCommand);
  const executable = basename(input.bridgeCommand, extname(input.bridgeCommand)).replace(
    /[^A-Za-z0-9_.-]/gu,
    "",
  );
  if (!executable) throw new Error("MCP_BRIDGE_EXECUTABLE_INVALID");
  const processScript = `
    $expectedPath = ${expectedPath}
    Get-Process -Name ${powershellLiteral(executable)} -ErrorAction SilentlyContinue |
      ForEach-Object {
        $proc = $_
        $path = try { [string]$proc.Path } catch { "" }
        if ([string]::Equals($path, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
          $startedAt = try { [string]$proc.StartTime.ToUniversalTime().ToString("o") } catch { "" }
          [pscustomobject]@{
            pid = [int]$proc.Id
            startedAt = $startedAt
            privateBytes = [int64]$proc.PrivateMemorySize64
          }
        }
      } | ConvertTo-Json -Compress
  `;
  const bridgeOutput = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    processScript,
  ]);
  const bridges = parseBridgeProcesses(bridgeOutput.stdout);
  const sampledAt = (input.now ?? (() => new Date()))().toISOString();
  if (bridges.length === 0) {
    return { sampledAt, metric: "PRIVATE_BYTES", totalPrivateBytes: 0, bridges: [] };
  }

  const counterOutput = await run("typeperf.exe", [
    `\\Process(${executable}*)\\ID Process`,
    `\\Process(${executable}*)\\Creating Process ID`,
    "-sc",
    "1",
  ]);
  const parentPids = parentPidByBridge(counterOutput.stdout);
  const distinctParentPids = [
    ...new Set(
      bridges
        .map((bridge) => parentPids.get(bridge.pid))
        .filter((pid): pid is number => pid !== undefined && pid > 0),
    ),
  ];
  let parentNames = new Map<number, string>();
  if (distinctParentPids.length > 0) {
    const parentScript = `
      $ids = @(${distinctParentPids.join(",")})
      $ids | ForEach-Object {
        $procId = $_
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) {
          [pscustomobject]@{ pid = [int]$proc.Id; name = [string]$proc.ProcessName }
        }
      } | ConvertTo-Json -Compress
    `;
    const parentOutput = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      parentScript,
    ]);
    parentNames = parseParentProcesses(parentOutput.stdout);
  }

  const observations = bridges.flatMap((bridge) => {
    const ownerPid = parentPids.get(bridge.pid);
    const ownerName = ownerPid === undefined ? undefined : parentNames.get(ownerPid);
    // 进程在候选采样与父进程采样之间退出时直接丢弃；数量与累计值只来自仍由受支持
    // Agent 直接持有的连接，绝不把 owner unknown 当作“可能是 bridge”继续计入。
    return ownerPid === undefined || !ownerName || !supportedAgentProcess(ownerName)
      ? []
      : [{ ...bridge, ownerPid, ownerName }];
  });
  return {
    sampledAt,
    metric: "PRIVATE_BYTES",
    totalPrivateBytes: observations.reduce((total, bridge) => total + bridge.privateBytes, 0),
    bridges: observations,
  };
}
