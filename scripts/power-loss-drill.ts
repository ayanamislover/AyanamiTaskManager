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
 *   recover     smoke 构建开窗，Agent 写一批，经界面建整库备份，再写一批；干净退出后破坏库（中段若干页写成
 *               乱码）。坏库上（07 S5′）：生产宿主记下 DATABASE_DAMAGED，不服务、不隔离、不建新库、库的字节不变，
 *               开着时 recover 以退出码 5 拒绝；smoke 构建的窗口显示恢复页，命令指向自带的 atm.exe。之后候选的
 *               atm.exe recover --offline --from <备份>（控制台输入 ID 确认）恢复：坏库进隔离区；lifecycle 记
 *               offline.recover；生产宿主健康、库完整、业务内容等于备份那一刻；服务在跑时 recover 以退出码 5
 *               拒绝、什么都不改。
 *
 * 报告写 output/power-loss/report.json。发布链的 power-loss 阶段跑全部场景；assemble-release 只认三个场景都跑过、
 * 每项通过、二进制与候选一致的报告（power-loss-report.ts、candidate-binaries.ts）。
 */
// 先于一切：这里拉起的宿主窗口不抢焦点、压在最底层（scripts/test-windows.ts）。
import "./test-windows.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type Page } from "@playwright/test";
import { agentFetch } from "./agent-fetch.js";
import { legacyBusiness, sameBusiness, v3Business, type Business } from "./business-summary.js";
import { binariesOf } from "./candidate-binaries.js";
import { POWER_LOSS_SCENARIOS, type PowerLossScenario } from "./power-loss-report.js";
import { unpackPortable } from "./portable-unpack.js";
import { rendererRequest } from "./renderer-user-request.js";
import { copySampleLibrary, ensureSampleLibrary } from "./sample-library.js";
import {
  assertSandboxDataDir,
  devToolsPortFile,
  outputRoot,
  readDevToolsPort,
  repoRoot,
  runtimeFile,
  smokeExecutable,
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

/** 宿主日志（`N\logs\host*.log`，含轮转的）里出现了 `needle`。 */
function hostLogged(needle: string): boolean {
  const logs = join(n, "logs");
  if (!existsSync(logs)) return false;
  return readdirSync(logs)
    .filter((name) => name.startsWith("host") && name.endsWith(".log"))
    .some((name) => readFileSync(join(logs, name), "utf8").includes(needle));
}

async function untilLogged(host: Host, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hostLogged(needle)) return true;
    if (host.child.exitCode !== null) return false;
    await sleep(200);
  }
  return false;
}

/**
 * 重启后没变健康时留下的线索：下一轮会清空 N，所以当场记下进程是否还在、M / A / 启动状态与宿主日志的末尾
 * （W8 关口第 3 次完整发布链：PUBLISHED 点重启后不健康，证据被下一轮清掉）。不读凭据：descriptor 不看。
 */
function unhealthyDetail(host: Host): Record<string, unknown> {
  const tail = (path: string, lines: number) =>
    existsSync(path) ? readFileSync(path, "utf8").trim().split(/\r?\n/u).slice(-lines) : null;
  return {
    exitCode: host.child.exitCode,
    manifest: readJson<{ phase: string; generation: string }>(join(n, "conversion.json")),
    authority: readJson<{ authority: string; by: string; generation: string }>(
      join(n, "authority.json"),
    ),
    startupState: readJson<{ state: string; reason: string }>(
      join(n, "runtime", "startup-state.json"),
    ),
    progress: readProgress(),
    hostLog: tail(join(n, "logs", "host.log"), 12),
  };
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
        const restartedHealthy = await untilHealthy(restarted, 180_000);
        if (
          !check(
            `${label}：原样重启后健康`,
            restartedHealthy,
            restartedHealthy ? undefined : unhealthyDetail(restarted),
          )
        )
          continue;
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
    const restartedHealthy = await untilHealthy(host, 60_000);
    if (
      !check(
        `第 ${round} 轮：原样重启后健康`,
        restartedHealthy,
        restartedHealthy ? undefined : unhealthyDetail(host),
      )
    )
      return;
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

// ---------------------------------------------------------------- 场景：recover --offline

const RECOVER_PROJECT = "RCV";

/** 宿主自带的 CLI（候选的那一份）。 */
const cliOf = (executable: string) => join(dirname(executable), "resources", "atm.exe");

function runCli(
  executable: string,
  args: string[],
  stdin = "",
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(cliOf(executable), args, {
    cwd: repoRoot,
    env: smokeHostEnvironment(dataDir, homeDir),
    input: stdin,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** smoke 构建开窗起来（用户的界面路径要经 CDP 驱动）；只有它认 --smoke-quit。 */
function startWindowedSmoke(smoke: string): Host {
  rmSync(devToolsPortFile(n), { force: true });
  const child = spawn(smoke, [], {
    cwd: repoRoot,
    env: smokeHostEnvironment(dataDir, homeDir),
    windowsHide: true,
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error(`smoke 宿主没能启动：${smoke}`);
  return { child, pid: child.pid };
}

async function quitSmoke(smoke: string, host: Host): Promise<boolean> {
  spawnSync(smoke, ["--smoke-quit"], {
    cwd: repoRoot,
    env: smokeHostEnvironment(dataDir, homeDir),
    windowsHide: true,
    timeout: 10_000,
  });
  if (await exited(host, 15_000)) return true;
  await powerCut(host);
  return false;
}

async function rendererPage(): Promise<{ browser: Browser; page: Page }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const port = await readDevToolsPort(n);
    if (port !== null) {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith("https://atm.localhost"));
      if (page) return { browser, page };
      await browser.close().catch(() => undefined);
    }
    await sleep(250);
  }
  throw new Error("等 WebView 的 CDP 连接超时");
}

async function agentWrites(rt: Runtime, session: string, prefix: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    const task = await post(rt, `/api/v1/projects/${RECOVER_PROJECT}/work-items`, {
      op_id: `${prefix}-${index}-task`,
      session,
      items: [{ client_ref: "t", title: `${prefix}-${index}`, status: "READY" }],
    });
    const record = await post(rt, `/api/v1/projects/${RECOVER_PROJECT}/records`, {
      op_id: `${prefix}-${index}-record`,
      session,
      kind: "FACT",
      title: `${prefix}-${index}`,
      summary: prefix,
    });
    if (task.json?.ok !== true || record.json?.ok !== true)
      throw new Error(`写入失败：${task.text.slice(0, 200)} / ${record.text.slice(0, 200)}`);
  }
}

/** 破坏库：把文件中段的若干页写成乱码（模拟坏扇区 / 被别的程序改坏），保留文件头。 */
function corrupt(path: string): { offset: number; bytes: number } {
  const content = readFileSync(path);
  const offset = 4096 * 4;
  const bytes = Math.min(4096 * 16, content.length - offset);
  if (bytes <= 0) throw new Error(`库太小，破坏不了：${content.length} 字节`);
  for (let index = 0; index < bytes; index += 1) content[offset + index] = (index * 131 + 7) & 0xff;
  writeFileSync(path, content);
  return { offset, bytes };
}

async function scenarioRecover(executable: string): Promise<void> {
  scenario = "recover";
  const smoke = smokeExecutable();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 2 });
  mkdirSync(dataDir, { recursive: true });
  rmSync(homeDir, { recursive: true, force: true, maxRetries: 2 });
  mkdirSync(join(homeDir, "Roaming"), { recursive: true });
  mkdirSync(join(homeDir, "Local"), { recursive: true });

  // 1. 写数据，经界面建整库备份，再写一批（恢复之后它们应当不在）。
  const host = startWindowedSmoke(smoke);
  let atBackup: Business | null = null;
  let backupId = "";
  try {
    if (!check("smoke 宿主健康", await untilHealthy(host, 60_000))) return;
    const rt = runtime();
    const created = await post(rt, "/api/v1/projects", {
      name: "恢复演练",
      code: RECOVER_PROJECT,
      op_id: "recover-project",
    });
    const begun = await post(rt, "/api/v1/sessions", {
      project_code: RECOVER_PROJECT,
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
    if (
      !check(
        "建项目、开会话",
        created.json?.ok === true && session.length > 0,
        created.text.slice(0, 200),
      )
    )
      return;
    await agentWrites(rt, session, "before", 30);
    const { browser, page } = await rendererPage();
    try {
      const backup = await rendererRequest<Record<string, unknown>>(
        page,
        "POST",
        "/api/v1/backups",
        {},
      );
      backupId = String(backup.body?.id ?? "");
      if (
        !check(
          "经界面建整库备份",
          backup.status >= 200 && backup.status < 300 && backupId.length > 0,
          backup,
        )
      )
        return;
    } finally {
      await browser.close().catch(() => undefined);
    }
    atBackup = v3Business(n);
    check(
      "备份那一刻的业务内容有数据",
      (atBackup?.records.length ?? 0) >= 30,
      atBackup?.records.length,
    );
    await agentWrites(rt, session, "after", 10);
    check(
      "备份之后又写了一批",
      (v3Business(n)?.records.length ?? 0) > (atBackup?.records.length ?? 0),
    );
  } finally {
    check("smoke 宿主经 --smoke-quit 干净退出", await quitSmoke(smoke, host));
  }

  // 2. 破坏库。坏库上（07 S5′，W8f-3）：不服务、不隔离、不建新库、不改库，等用户退出后恢复。
  const db = join(n, "data", "atm.sqlite");
  // WAL 在不在只影响破坏落在哪一层，不是验收项，如实记下。
  check(
    `退出后的 WAL：${existsSync(`${db}-wal`) ? `${readFileSync(`${db}-wal`).length} 字节` : "没有"}`,
    true,
  );
  const damage = corrupt(db);
  const damaged = readFileSync(db);
  check(`库的第 ${damage.offset / 4096} 页起 ${damage.bytes / 4096} 页写成乱码`, true);
  const untouched = () =>
    !existsSync(join(n, "quarantine")) && existsSync(db) && readFileSync(db).equals(damaged);
  const broken = startHost(executable);
  try {
    check(
      "坏库上的生产宿主记下 DATABASE_DAMAGED",
      await untilLogged(broken, "DATABASE_DAMAGED", 60_000),
    );
    check(
      "坏库上的生产宿主不服务、进程还在（等用户）",
      !(await untilHealthy(broken, 5_000)) && broken.child.exitCode === null,
      { exitCode: broken.child.exitCode },
    );
    check("坏库没有被隔离，也没有建新库，字节不变", untouched());
    // W8h：重试过还读不出，宿主记下损坏状态；CLI（与桥）据此立刻报 ATM_DATABASE_DAMAGED，不再等服务。
    const damagedState = join(n, "runtime", "damaged.json");
    const recorded = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !existsSync(damagedState)) await sleep(200);
      return existsSync(damagedState);
    })();
    check("坏库上的生产宿主写下 runtime\\damaged.json", recorded);
    const status = runCli(executable, ["--json", "status"]);
    const statusCode = (() => {
      try {
        return (JSON.parse(status.stdout) as { error?: { code?: string } }).error?.code ?? null;
      } catch {
        return null;
      }
    })();
    check(
      "CLI 立刻报 ATM_DATABASE_DAMAGED（退出码 4）",
      status.code === 4 && statusCode === "ATM_DATABASE_DAMAGED",
      {
        code: status.code,
        stdout: status.stdout.slice(0, 300),
      },
    );
    const refused = runCli(
      executable,
      ["--json", "recover", "--offline", "--from", backupId],
      `${backupId}\n`,
    );
    check("宿主开着时 recover 被拒绝（退出码 5），库没动", refused.code === 5 && untouched(), {
      code: refused.code,
      stderr: refused.stderr.slice(0, 300),
    });
  } finally {
    await powerCut(broken);
  }
  // 界面：smoke 构建（同一份源码，带 CDP）在坏库上显示恢复页。
  const shown = startWindowedSmoke(smoke);
  try {
    const { browser, page } = await rendererPage();
    try {
      const title = page.getByText("数据库读不出，需要从备份恢复");
      const visible = await title
        .waitFor({ timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      const command = visible
        ? ((await page.locator(".atm-damaged-command").textContent()) ?? "")
        : "";
      check(
        "smoke 宿主的窗口显示恢复页，命令是它自带的 atm.exe recover --offline",
        visible && /^& '.+\\atm\.exe' recover --offline$/u.test(command),
        command,
      );
      // W8h：恢复页列出整库备份，标出恢复命令默认用的那一份。
      const row = page.locator(".atm-damaged-backups .atm-row", { hasText: backupId });
      const listedOnPage = visible
        ? await row
            .waitFor({ timeout: 60_000 })
            .then(() => true)
            .catch(() => false)
        : false;
      const rowText = listedOnPage ? ((await row.textContent()) ?? "") : "";
      check(
        "恢复页列出这份备份，标为恢复命令默认用的那一份",
        listedOnPage && rowText.includes("恢复命令默认用这一份"),
        rowText,
      );
    } finally {
      await browser.close().catch(() => undefined);
    }
  } finally {
    check("smoke 宿主经 --smoke-quit 干净退出（坏库上）", await quitSmoke(smoke, shown));
  }
  check("看过恢复页之后库仍然没动", untouched());

  const listed = runCli(executable, ["--json", "recover", "--offline", "--list"]);
  const list = (() => {
    try {
      return JSON.parse(listed.stdout) as { backups: Array<{ id: string; status: string }> };
    } catch {
      return null;
    }
  })();
  check(
    "--list 列出这份备份且可用",
    list?.backups.some((b) => b.id === backupId && b.status === "USABLE") === true,
    listed.stdout.slice(0, 400),
  );

  // 3. 恢复：控制台输入备份 ID 确认（不用测试模式的 --yes）。
  const recovered = runCli(
    executable,
    ["--json", "recover", "--offline", "--from", backupId],
    `${backupId}\n`,
  );
  const result = (() => {
    try {
      return JSON.parse(recovered.stdout) as { backup_id: string; quarantine?: string };
    } catch {
      return null;
    }
  })();
  check(
    "recover --offline 恢复成功",
    recovered.code === 0 && result?.backup_id === backupId,
    recovered,
  );
  check(
    "坏库移进了隔离区，没有删",
    typeof result?.quarantine === "string" && existsSync(result.quarantine),
    result,
  );
  check("恢复完删掉了 runtime\\damaged.json", !existsSync(join(n, "runtime", "damaged.json")));
  const lifecycle = readFileSync(join(n, "logs", "lifecycle.ndjson"), "utf8")
    .trim()
    .split(/\r?\n/u);
  check(
    "lifecycle 记了 offline.recover",
    lifecycle.some((line) => line.includes('"offline.recover"') && line.includes(backupId)),
  );

  // 4. 生产宿主在恢复后的库上：健康、完整、业务内容等于备份那一刻。
  const after = startHost(executable);
  try {
    check("恢复后生产宿主健康", await untilHealthy(after, 60_000));
    const health = integrity();
    check(
      "恢复后库 integrity_check 为 ok",
      Object.values(health).every((v) => v === "ok") && Object.keys(health).length > 0,
      health,
    );
    check("业务内容等于备份那一刻（备份之后写的那批不在）", sameBusiness(v3Business(n), atBackup), {
      atBackup: atBackup?.records.length,
      now: v3Business(n)?.records.length,
    });
    const refused = runCli(
      executable,
      ["--json", "recover", "--offline", "--from", backupId],
      `${backupId}\n`,
    );
    check(
      "服务在跑时 recover 被拒绝（退出码 5），什么都没改",
      refused.code === 5 && sameBusiness(v3Business(n), atBackup),
      {
        code: refused.code,
        stderr: refused.stderr.slice(0, 300),
      },
    );
  } finally {
    await powerCut(after);
  }
}

// ---------------------------------------------------------------- 主流程

const only = process.argv.includes("--only")
  ? (process.argv[process.argv.indexOf("--only") + 1] ?? "").split(",").filter(Boolean)
  : [];
const RUNS: Record<PowerLossScenario, (executable: string) => Promise<void>> = {
  conversion: scenarioConversion,
  writes: scenarioWrites,
  recover: scenarioRecover,
};
for (const name of only)
  if (!POWER_LOSS_SCENARIOS.some((known) => known === name))
    throw new Error(`没有这个场景：${name}`);
const ran: PowerLossScenario[] = [];

const startedAt = new Date().toISOString();
await ensureSampleLibrary(seedDir, repoRoot);
const executable = unpackPortable(packageDir, portableRoot);
let error: string | null = null;
try {
  await withLoginItemsRestored(async () => {
    for (const name of POWER_LOSS_SCENARIOS)
      if (only.length === 0 || only.includes(name)) {
        ran.push(name);
        await RUNS[name](executable);
      }
  }, [executable, smokeExecutable()]);
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
  // 发布链只认三个场景都跑过的报告（power-loss-report.ts）。
  scenarios: ran,
  // 候选绑定（L6）：杀的是生产便携包；recover 场景经界面建备份、看恢复页用的是 smoke 构建。
  binaries: {
    production: binariesOf(dirname(executable)),
    smoke: binariesOf(dirname(smokeExecutable())),
  },
  checks,
};
mkdirSync(drillRoot, { recursive: true });
writeFileSync(join(drillRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `\n${checks.length - failed.length}/${checks.length} checks passed → ${join(drillRoot, "report.json")}\n`,
);
process.exitCode = report.passed ? 0 : 1;
