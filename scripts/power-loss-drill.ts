/**
 * 掉电演练（W8f，ATM-T-0894）：真宿主、真强杀（TerminateProcess），全部在 output/ 下的合成数据根上。
 *
 *   pnpm exec tsx scripts/power-loss-drill.ts                      # 全部场景
 *   pnpm exec tsx scripts/power-loss-drill.ts --only conversion
 *
 * 杀的是 output/package 里的生产便携包（候选，报告记它的哈希供 L6 绑定）。store 的 fault_matrix 用的
 * 是注入的「停下」（连接照常关闭）；这里是进程真的没了：未提交的 WAL 帧、半个 staging、没删的
 * 运行文件都原样留着，下一次启动自己收拾。
 *
 * 场景：
 *   conversion  2.x 样本库（100 个项目、1 万任务、4 万文档）首次转换；startup-progress.json 每进入一个
 *               阶段（SNAPSHOT / IMPORT 过半 / VERIFY / PUBLISHING / PUBLISHED）就强杀，原样重启。重启后：
 *               健康；conversion.json 是 PUBLISHED，业务摘要与一次干净转换逐表相同；3.x 业务内容相同；
 *               库 integrity_check 为 ok；staging 只剩发布的那一代；authority 指向它；L 的业务内容没动。
 *
 * 报告写 output/power-loss/report.json。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { agentFetch } from "./agent-fetch.js";
import { legacyBusiness, sameBusiness, v3Business, type Business } from "./business-summary.js";
import { binariesOf } from "./candidate-binaries.js";
import { unpackPortable } from "./portable-unpack.js";
import { copySampleLibrary, ensureSampleLibrary } from "./sample-library.js";
import {
  assertSandboxDataDir,
  outputRoot,
  repoRoot,
  runtimeFile,
  smokeHostEnvironment,
  v3Root,
  withLoginItemsRestored,
} from "./smoke-host.js";

const drillRoot = assertSandboxDataDir(join(outputRoot, "power-loss"));
const seedDir = assertSandboxDataDir(join(outputRoot, "budget-seed-data"));
const portableRoot = assertSandboxDataDir(join(outputRoot, "power-loss-portable"));
const packageDir = join(outputRoot, "package");
const dataDir = join(drillRoot, "L");
const homeDir = join(drillRoot, "home");
const n = v3Root(homeDir);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 检查与报告

type Check = { scenario: string; name: string; passed: boolean; detail?: unknown };
const checks: Check[] = [];
let scenario = "";

function check(name: string, passed: boolean, detail?: unknown): boolean {
  checks.push({ scenario, name, passed, ...(detail === undefined ? {} : { detail }) });
  process.stdout.write(`  ${passed ? "✓" : "✗"} ${name}\n`);
  if (!passed && detail !== undefined)
    process.stdout.write(`      ${JSON.stringify(detail).slice(0, 600)}\n`);
  return passed;
}

// ---------------------------------------------------------------- 宿主

type Host = { child: ChildProcess; pid: number };

function startHost(executable: string): Host {
  const child = spawn(executable, ["--background"], {
    cwd: repoRoot,
    env: smokeHostEnvironment(dataDir, homeDir),
    windowsHide: true,
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error(`宿主没能启动：${executable}`);
  return { child, pid: child.pid };
}

function exited(host: Host, timeoutMs: number): Promise<boolean> {
  if (host.child.exitCode !== null || host.child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise<boolean>((done) => host.child.once("exit", () => done(true))),
    sleep(timeoutMs).then(() => false),
  ]);
}

/** 掉电：TerminateProcess，不给任何收尾的机会。 */
async function powerCut(host: Host): Promise<void> {
  host.child.kill("SIGKILL");
  if (!(await exited(host, 10_000))) throw new Error(`强杀后宿主没有退出：${host.pid}`);
}

async function healthy(): Promise<boolean> {
  if (!existsSync(runtimeFile(n))) return false;
  try {
    const runtime = JSON.parse(readFileSync(runtimeFile(n), "utf8")) as {
      token: string;
      endpoint: string;
    };
    const response = await agentFetch(`${runtime.endpoint}/api/v1/system/status`, {
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function untilHealthy(host: Host, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (host.child.exitCode !== null) return false;
    if (await healthy()) return true;
    await sleep(100);
  }
  return false;
}

// ---------------------------------------------------------------- 数据根

/** 这一轮的 L 是样本库的新副本，N（合成 home 整个）清空。 */
function freshRoots(): void {
  copySampleLibrary(seedDir, dataDir);
  rmSync(homeDir, { recursive: true, force: true, maxRetries: 2 });
  mkdirSync(join(homeDir, "Roaming"), { recursive: true });
  mkdirSync(join(homeDir, "Local"), { recursive: true });
}

type Progress = { phase: string; done: number; total: number };

function readProgress(): Progress | null {
  try {
    const value = JSON.parse(readFileSync(join(n, "runtime", "startup-progress.json"), "utf8")) as {
      phase: string;
      progress: { done: number; total: number };
    };
    return { phase: value.phase, done: value.progress.done, total: value.progress.total };
  } catch {
    return null;
  }
}

type Manifest = { phase: string; generation: string; business_digest: Record<string, string> };

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** N 里每个 SQLite 库的 integrity_check（只读打开；宿主可以开着，WAL 下读不阻塞写）。 */
function integrity(): Record<string, string> {
  const result: Record<string, string> = {};
  const data = join(n, "data");
  for (const name of existsSync(data) ? readdirSync(data) : [])
    if (name.endsWith(".sqlite")) {
      const db = new DatabaseSync(join(data, name), { readOnly: true });
      try {
        const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, string>>;
        result[name] = rows.map((row) => Object.values(row)[0]).join("; ");
      } finally {
        db.close();
      }
    }
  return result;
}

// ---------------------------------------------------------------- 场景：转换中掉电

/** 每个阶段的「杀点」：看到这个进度就杀。IMPORT 等到过半，才是正在写的那一刻。 */
const CUT_POINTS: Array<{ name: string; at: (p: Progress) => boolean }> = [
  { name: "SNAPSHOT", at: (p) => p.phase === "SNAPSHOT" && p.done > 0 },
  { name: "IMPORT", at: (p) => p.phase === "IMPORT" && p.total > 0 && p.done * 2 >= p.total },
  { name: "VERIFY", at: (p) => p.phase === "VERIFY" },
  { name: "PUBLISHING", at: (p) => p.phase === "PUBLISHING" },
  { name: "PUBLISHED", at: (p) => p.phase === "PUBLISHED" },
];

type Reference = { digest: Record<string, string>; business: Business; legacy: Business };

async function cleanConversion(executable: string): Promise<Reference> {
  freshRoots();
  const legacy = legacyBusiness(dataDir)!;
  const host = startHost(executable);
  try {
    if (!check("干净转换：宿主健康", await untilHealthy(host, 180_000)))
      throw new Error("干净转换没有完成，后面的对照无从谈起");
    const manifest = readJson<Manifest>(join(n, "conversion.json"));
    check(
      "干净转换：conversion.json 是 PUBLISHED",
      manifest?.phase === "PUBLISHED",
      manifest?.phase,
    );
    const business = v3Business(n);
    check("干净转换：3.x 业务内容与 L 相同", sameBusiness(business, legacy));
    return { digest: manifest!.business_digest, business: business!, legacy };
  } finally {
    await powerCut(host);
  }
}

async function cutDuringConversion(executable: string, reference: Reference): Promise<void> {
  for (const point of CUT_POINTS) {
    let exercised = false;
    for (let round = 1; round <= 3 && !exercised; round += 1) {
      const label = round > 1 ? `${point.name} 第 ${round} 轮` : point.name;
      process.stdout.write(`\n[conversion] 在 ${label} 掉电\n`);
      freshRoots();
      const host = startHost(executable);
      let seen: Progress | null = null;
      let servedFirst = false;
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline && host.child.exitCode === null) {
        const progress = readProgress();
        if (progress && point.at(progress)) {
          seen = progress;
          break;
        }
        // 已经在服务了还没看到这个阶段：这一轮错过了。
        if (existsSync(runtimeFile(n))) {
          servedFirst = true;
          break;
        }
        await sleep(2);
      }
      await powerCut(host);
      exercised = seen !== null;
      if (!exercised) {
        process.stdout.write(
          `  · 没赶上 ${point.name}（${servedFirst ? "已经在服务" : "超时"}），再来一轮\n`,
        );
        continue;
      }
      check(`${label}：在 ${seen!.phase} ${seen!.done}/${seen!.total} 强杀`, true);
      check(`${label}：L 的业务内容没动`, sameBusiness(legacyBusiness(dataDir), reference.legacy));

      const restarted = startHost(executable);
      try {
        if (!check(`${label}：原样重启后健康`, await untilHealthy(restarted, 180_000))) continue;
        const manifest = readJson<Manifest>(join(n, "conversion.json"));
        check(
          `${label}：conversion.json 是 PUBLISHED`,
          manifest?.phase === "PUBLISHED",
          manifest?.phase,
        );
        check(
          `${label}：业务摘要与干净转换逐表相同`,
          manifest !== null && isDeepStrictEqual(manifest.business_digest, reference.digest),
          manifest === null
            ? "manifest 读不出"
            : diffKeys(manifest.business_digest, reference.digest),
        );
        check(
          `${label}：3.x 业务内容与干净转换相同`,
          sameBusiness(v3Business(n), reference.business),
        );
        const health = integrity();
        check(
          `${label}：库 integrity_check 为 ok`,
          Object.keys(health).length > 0 && Object.values(health).every((value) => value === "ok"),
          health,
        );
        const staging = existsSync(join(n, "staging")) ? readdirSync(join(n, "staging")) : [];
        check(
          `${label}：staging 只剩发布的那一代`,
          manifest !== null && isDeepStrictEqual(staging, [manifest.generation]),
          { staging, generation: manifest?.generation },
        );
        const authority = readJson<{ authority: string; generation: string }>(
          join(n, "authority.json"),
        );
        check(
          `${label}：authority 指向发布的那一代`,
          authority?.authority === "v3" && authority.generation === manifest?.generation,
          authority,
        );
      } finally {
        await powerCut(restarted);
      }
    }
    check(`${point.name}：赶上了这个阶段`, exercised);
  }
}

function diffKeys(left: Record<string, string>, right: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => left[key] !== right[key]).slice(0, 20);
}

async function scenarioConversion(executable: string): Promise<void> {
  scenario = "conversion";
  process.stdout.write("\n[conversion] 干净的一次，作对照\n");
  const reference = await cleanConversion(executable);
  await cutDuringConversion(executable, reference);
}

// ---------------------------------------------------------------- 主流程

const only = process.argv.includes("--only")
  ? (process.argv[process.argv.indexOf("--only") + 1] ?? "").split(",").filter(Boolean)
  : [];
const SCENARIOS: Array<[string, (executable: string) => Promise<void>]> = [
  ["conversion", scenarioConversion],
];
for (const name of only)
  if (!SCENARIOS.some(([known]) => known === name)) throw new Error(`没有这个场景：${name}`);

const startedAt = new Date().toISOString();
await ensureSampleLibrary(seedDir, repoRoot);
const executable = unpackPortable(packageDir, portableRoot);
let error: string | null = null;
try {
  await withLoginItemsRestored(async () => {
    for (const [name, run] of SCENARIOS)
      if (only.length === 0 || only.includes(name)) await run(executable);
  }, [executable]);
} catch (caught) {
  error = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
  process.stderr.write(`${error}\n`);
}
const failed = checks.filter((entry) => !entry.passed);
const report = {
  startedAt,
  completedAt: new Date().toISOString(),
  passed: error === null && failed.length === 0 && checks.length > 0,
  total: checks.length,
  failed: failed.length,
  error,
  // 候选绑定（L6）：杀的是这份。
  binaries: binariesOf(dirname(executable)),
  checks,
};
mkdirSync(drillRoot, { recursive: true });
writeFileSync(join(drillRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `\n${checks.length - failed.length}/${checks.length} checks passed → ${join(drillRoot, "report.json")}\n`,
);
process.exitCode = report.passed ? 0 : 1;
