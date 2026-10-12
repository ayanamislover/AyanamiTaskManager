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
 *   writes      全新 3.x 宿主上 Agent 连续写（建任务、项目进度、记录，各带 op_id），在确定性的随机时刻
 *               强杀，原样重启，共 8 轮。每轮：库 integrity_check 为 ok；已确认的写入都在、各只有一份；任务数
 *               与 work.created 事件数一致；断电时在途的那一条用同一 op_id 重放后恰好一份（断电前已提交的
 *               认出回执、没提交的写入一次）；全部已确认的重放都认出回执，库里一条没多。
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

// ---------------------------------------------------------------- 场景：日常写入中掉电

const WRITE_PROJECT = "PLD";
const WRITE_ROUNDS = 8;

type Runtime = { endpoint: string; token: string };
type Op = {
  opId: string;
  kind: "task" | "progress" | "record";
  marker: string;
  path: string;
  body: object;
};

function runtime(): Runtime {
  return JSON.parse(readFileSync(runtimeFile(n), "utf8")) as Runtime;
}

async function post(rt: Runtime, path: string, body: object) {
  const response = await agentFetch(`${rt.endpoint}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${rt.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = Buffer.from(await response.arrayBuffer()).toString("utf8");
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 非 JSON 回包原样留在 text 里。
  }
  return { status: response.status, json, text };
}

/** 第 i 个写入：建任务、写项目进度、写记录，轮着来；标记串写进标题 / 摘要，按它在库里找。 */
function nthOp(round: number, index: number, session: string): Op {
  const marker = `pl-${round}-${index}`;
  const base = `/api/v1/projects/${WRITE_PROJECT}`;
  switch (index % 3) {
    case 0:
      return {
        opId: `${marker}-task`,
        kind: "task",
        marker,
        path: `${base}/work-items`,
        body: {
          op_id: `${marker}-task`,
          session,
          items: [{ client_ref: "t", title: marker, status: "READY" }],
        },
      };
    case 1:
      return {
        opId: `${marker}-progress`,
        kind: "progress",
        marker,
        path: `${base}/progress-updates`,
        body: { op_id: `${marker}-progress`, session, scope: "project", summary: marker },
      };
    default:
      return {
        opId: `${marker}-record`,
        kind: "record",
        marker,
        path: `${base}/records`,
        body: {
          op_id: `${marker}-record`,
          session,
          kind: "FACT",
          title: marker,
          summary: marker,
        },
      };
  }
}

/** 库里每个标记出现几次（只读打开；宿主在跑，WAL 下读不阻塞写）。 */
function markerCounts(): { counts: Map<string, number>; tasks: number; created: number } {
  const db = new DatabaseSync(join(n, "data", "atm.sqlite"), { readOnly: true });
  try {
    const project = db.prepare("SELECT id FROM projects WHERE code = ?").get(WRITE_PROJECT) as
      | { id: string }
      | undefined;
    if (!project) throw new Error(`没有项目 ${WRITE_PROJECT}`);
    const counts = new Map<string, number>();
    const add = (rows: Array<{ marker: string }>, kind: string) => {
      for (const row of rows)
        counts.set(`${row.marker}#${kind}`, (counts.get(`${row.marker}#${kind}`) ?? 0) + 1);
    };
    add(
      db
        .prepare("SELECT title AS marker FROM work_items WHERE project_id = ?")
        .all(project.id) as Array<{ marker: string }>,
      "task",
    );
    add(
      db
        // 项目级进度（scope: project）落在 project_updates；progress_updates 是任务级的。
        .prepare("SELECT summary AS marker FROM project_updates WHERE project_id = ?")
        .all(project.id) as Array<{ marker: string }>,
      "progress",
    );
    add(
      db
        .prepare("SELECT title AS marker FROM records WHERE project_id = ?")
        .all(project.id) as Array<{ marker: string }>,
      "record",
    );
    const tasks = (
      db.prepare("SELECT count(*) AS c FROM work_items WHERE project_id = ?").get(project.id) as {
        c: number;
      }
    ).c;
    const created = (
      db
        .prepare("SELECT count(*) AS c FROM events WHERE project_id = ? AND type = 'work.created'")
        .get(project.id) as { c: number }
    ).c;
    return { counts, tasks, created };
  } finally {
    db.close();
  }
}

const countOf = (snapshot: ReturnType<typeof markerCounts>, op: Op) =>
  snapshot.counts.get(`${op.marker}#${op.kind}`) ?? 0;

/** 确定性的「随机」：同一个种子每次演练都在同样的时刻断电，可以复现。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

async function scenarioWrites(executable: string): Promise<void> {
  scenario = "writes";
  // 空 L：没有 2.x 数据，宿主是全新的 3.x；项目由 Agent 建。
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 2 });
  mkdirSync(dataDir, { recursive: true });
  rmSync(homeDir, { recursive: true, force: true, maxRetries: 2 });
  mkdirSync(join(homeDir, "Roaming"), { recursive: true });
  mkdirSync(join(homeDir, "Local"), { recursive: true });
  let host = startHost(executable);
  if (!check("全新宿主健康", await untilHealthy(host, 60_000))) return;
  const created = await post(runtime(), "/api/v1/projects", {
    name: "掉电演练",
    code: WRITE_PROJECT,
    op_id: "power-loss-project",
  });
  if (
    !check(
      "建项目",
      [200, 201].includes(created.status) && created.json?.ok === true,
      created.text.slice(0, 300),
    )
  )
    return;
  // Agent 的写入要带会话（atm_begin）；会话落在库里，重启之后照样能用。
  const begun = await post(runtime(), "/api/v1/sessions", {
    project_code: WRITE_PROJECT,
    mode: "project",
    agent_id: "power-loss-drill",
    client_kind: "release-drill",
  });
  const session = String(
    (begun.json?.session as string | undefined) ??
      ((begun.json?.result as Record<string, unknown> | undefined)?.session as
        | string
        | undefined) ??
      "",
  );
  if (!check("开会话", session.length > 0, begun.text.slice(0, 300))) return;

  const random = lcg(0x5eed);
  const acked: Op[] = [];
  for (let round = 1; round <= WRITE_ROUNDS; round += 1) {
    process.stdout.write(`\n[writes] 第 ${round} 轮\n`);
    const rt = runtime();
    const cutAfterMs = 300 + Math.floor(random() * 1200);
    let inFlight: Op | null = null;
    let index = 0;
    let stop = false;
    // 错误当场接住、事后再报：断电前的 sleep 里没人等它，拒绝没人接会让整个演练进程崩掉。
    const writer = (async () => {
      while (!stop) {
        const op = nthOp(round, index, session);
        index += 1;
        inFlight = op;
        try {
          const result = await post(rt, op.path, op.body);
          if (result.status >= 200 && result.status < 300 && result.json?.ok === true) {
            acked.push(op);
            inFlight = null;
          } else {
            throw new Error(`写入被拒：${op.opId} ${result.status} ${result.text.slice(0, 300)}`);
          }
        } catch (error) {
          // 断电那一刻的请求：连接断了。别的错误照实报。
          if (!stop) throw error;
          return;
        }
      }
    })().then(
      () => null,
      (error: unknown) => error,
    );
    await sleep(cutAfterMs);
    stop = true;
    await powerCut(host);
    const failure = await writer;
    check(`第 ${round} 轮：写入只在断电时中断`, failure === null, String(failure));
    const lost = inFlight as Op | null;
    check(
      `第 ${round} 轮：断电前确认了 ${acked.length} 条写入，断电时${lost ? `正在写 ${lost.opId}` : "没有在途写入"}`,
      true,
    );

    host = startHost(executable);
    if (!check(`第 ${round} 轮：原样重启后健康`, await untilHealthy(host, 60_000))) return;
    const health = integrity();
    check(
      `第 ${round} 轮：库 integrity_check 为 ok`,
      Object.values(health).every((v) => v === "ok") && Object.keys(health).length > 0,
      health,
    );
    const before = markerCounts();
    const missing = acked.filter((op) => countOf(before, op) !== 1);
    check(
      `第 ${round} 轮：已确认的 ${acked.length} 条写入都在、各只有一份`,
      missing.length === 0,
      missing.slice(0, 10).map((op) => `${op.opId}=${countOf(before, op)}`),
    );
    check(`第 ${round} 轮：任务数与 work.created 事件数一致`, before.tasks === before.created, {
      tasks: before.tasks,
      created: before.created,
    });

    const rt2 = runtime();
    if (lost) {
      const was = countOf(before, lost);
      const replay = await post(rt2, lost.path, lost.body);
      const after = markerCounts();
      check(
        `第 ${round} 轮：在途的 ${lost.opId} 重放后恰好一份（断电前${was === 1 ? "已提交" : "未提交"}，重放${replay.json?.replayed === true ? "认出回执" : "写入"}）`,
        replay.json?.ok === true &&
          countOf(after, lost) === 1 &&
          (was === 1) === (replay.json?.replayed === true),
        { status: replay.status, body: replay.text.slice(0, 300), was },
      );
      acked.push(lost);
    }
    // 已确认的全部重放一遍：都应认出回执、不再写。
    const snapshot = markerCounts();
    const notReplayed: string[] = [];
    for (const op of acked) {
      const replay = await post(rt2, op.path, op.body);
      if (replay.json?.ok !== true || replay.json?.replayed !== true)
        notReplayed.push(`${op.opId} ${replay.status}`);
    }
    const afterReplay = markerCounts();
    check(
      `第 ${round} 轮：${acked.length} 条重放都认出回执`,
      notReplayed.length === 0,
      notReplayed.slice(0, 10),
    );
    check(
      `第 ${round} 轮：重放之后库里一条没多`,
      acked.every((op) => countOf(afterReplay, op) === countOf(snapshot, op)) &&
        afterReplay.tasks === snapshot.tasks,
    );
  }
  await powerCut(host);
}

// ---------------------------------------------------------------- 主流程

const only = process.argv.includes("--only")
  ? (process.argv[process.argv.indexOf("--only") + 1] ?? "").split(",").filter(Boolean)
  : [];
const SCENARIOS: Array<[string, (executable: string) => Promise<void>]> = [
  ["conversion", scenarioConversion],
  ["writes", scenarioWrites],
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
