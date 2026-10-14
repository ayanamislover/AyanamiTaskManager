/**
 * 长转换不会被看门狗当成挂住（07 §8 末条，W8b）：smoke 宿主把看门狗阈值调到 500 ms
 * （`ATM_SMOKE_WATCHDOG_MS`），给它一份转换要好几秒的 2.x 数据根，看它转换完、开始服务、
 * 一直活着，生命周期记录里没有 `watchdog.stall`。
 *
 * 2.x 数据根是 2.0 真实写出的那份夹具（`output/source-choice-fixture/L`）的副本，往 registry 里
 * 灌四十万条临时任务（与 runtime 用例的 `touch_legacy` 同一种写法），让 IMPORT / VERIFY 明显长过阈值。
 * 转换期间每 100 ms 记一次 `N\runtime\startup-progress.json`，报告里能看到进度一路在动。
 *
 * 全部在 output/ 下的沙箱里（合成 LOCALAPPDATA / APPDATA），结束时删掉；报告留在
 * output/conversion-watchdog-smoke/report.json。
 *
 *   ATM_SMOKE_HOST_EXE=<smoke 宿主> pnpm exec tsx scripts/conversion-watchdog-smoke.ts
 */
// 先于一切：这里拉起的宿主窗口不抢焦点、压在最底层（scripts/test-windows.ts）。
import "./test-windows.js";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertSmokeHost } from "./package-native.js";
import { legacyBusiness, v3Business } from "./business-summary.js";
import {
  assertSandboxDataDir,
  delay,
  exited,
  outputRoot,
  repoRoot,
  snapshotLoginItems,
  startSmokeHost,
  stopSmokeHost,
} from "./smoke-host.js";

const QUICK_TASKS = 400_000;
const WATCHDOG_MS = 500;
const fixture = join(outputRoot, "source-choice-fixture", "L");
const reportDir = assertSandboxDataDir(join(outputRoot, "conversion-watchdog-smoke"));
const sandbox = assertSandboxDataDir(join(outputRoot, "conversion-watchdog-sandbox"));
const home = join(sandbox, "home");
const legacy = join(home, "Local", "AyanamiTaskManager");
const n = join(home, "Local", "AyanamiTaskManager3");

const report: {
  quickTasks: number;
  watchdogMs: number;
  convertedMs?: number;
  progress: Array<{ atMs: number; phase: string; done: number; total: number; work: number }>;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
} = { quickTasks: QUICK_TASKS, watchdogMs: WATCHDOG_MS, progress: [], checks: [] };

function check(name: string, passed: boolean, detail?: unknown): void {
  report.checks.push({
    name,
    passed,
    ...(passed || detail === undefined ? {} : { detail: JSON.stringify(detail).slice(0, 400) }),
  });
  process.stdout.write(
    `  ${passed ? "✓" : "✗"} ${name}${passed ? "" : `  ${JSON.stringify(detail)}`}\n`,
  );
}

function hostExe(): string {
  const given = process.env.ATM_SMOKE_HOST_EXE;
  if (!given)
    throw new Error("给 ATM_SMOKE_HOST_EXE（smoke 构建的宿主，见 scripts/source-choice-smoke.ts）");
  const executable = resolve(given);
  assertSmokeHost(readFileSync(executable));
  return executable;
}

// 先拍 Run 快照再起宿主：快照读不到时宿主还没起来，没有要收拾的。
const executable = hostExe();
const loginItems = snapshotLoginItems([executable]);

/** 四十万条临时任务，写法同 runtime/tests/support 的 `touch_legacy`。 */
function amplify(root: string): void {
  const db = new DatabaseSync(join(root, "registry", "registry.sqlite"));
  try {
    const insert = db.prepare(
      "INSERT INTO quick_tasks (id, local_no, title, status, actor, created_at, updated_at) VALUES (?, ?, ?, 'OPEN', 'USER', ?, ?)",
    );
    const at = "2026-10-11T00:00:00.000Z";
    db.exec("BEGIN");
    for (let i = 1; i <= QUICK_TASKS; i++)
      insert.run(`QW${String(i).padStart(6, "0")}`, 1000 + i, `长转换演练 ${i}`, at, at);
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

async function main(executable: string): Promise<void> {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
  rmSync(reportDir, { recursive: true, force: true });
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(join(home, "Roaming"), { recursive: true });
  cpSync(fixture, legacy, { recursive: true });
  amplify(legacy);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM3_DATA_DIR"].includes(entry[0]),
    ),
  );
  const env = {
    ...inherited,
    LOCALAPPDATA: join(home, "Local"),
    APPDATA: join(home, "Roaming"),
    ATM_SMOKE_CORE_USERPROFILE: home,
    ATM_DEV_REPOSITORY_ROOT: repoRoot,
    ATM_SMOKE_WATCHDOG_MS: String(WATCHDOG_MS),
  };
  const begun = Date.now();
  const host = startSmokeHost({ executable, v3Dir: n, env });
  try {
    const progressPath = join(n, "runtime", "startup-progress.json");
    let last = "";
    while (!existsSync(join(n, "runtime", "daemon.json"))) {
      if (exited(host.child)) throw new Error(`宿主在转换中退出：${host.child.exitCode}`);
      if (Date.now() - begun > 600_000) throw new Error("10 分钟内没有转换完");
      try {
        const p = JSON.parse(readFileSync(progressPath, "utf8")) as {
          phase: string;
          progress: { done: number; total: number; work: number };
        };
        const key = `${p.phase} ${p.progress.done}/${p.progress.total} ${p.progress.work}`;
        if (key !== last) {
          last = key;
          report.progress.push({ atMs: Date.now() - begun, phase: p.phase, ...p.progress });
        }
      } catch {
        // 还没写、或正在改名：下一轮再读。
      }
      await delay(100);
    }
    report.convertedMs = Date.now() - begun;
    check(
      `转换用时 ${(report.convertedMs / 1000).toFixed(1)} s，远长于看门狗阈值 ${WATCHDOG_MS} ms`,
      report.convertedMs > WATCHDOG_MS * 6,
      report.convertedMs,
    );
    check(
      "转换期间进度一路在动（至少 5 次变化）",
      report.progress.length >= 5,
      report.progress.length,
    );
    // 服务之后再活过好几个阈值。
    await delay(WATCHDOG_MS * 8);
    check("宿主一直活着", !exited(host.child), host.child.exitCode);
    const lifecycle = join(n, "logs", "lifecycle.ndjson");
    const events = existsSync(lifecycle)
      ? readFileSync(lifecycle, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { event: string }).event)
      : [];
    check("生命周期记录里没有 watchdog.stall", !events.includes("watchdog.stall"), events);
    check("生命周期记录到了 ready", events.includes("ready"), events);
    const l = legacyBusiness(legacy);
    const v3 = v3Business(n);
    check("项目与记录逐条一致", JSON.stringify(l) === JSON.stringify(v3), { l, v3 });
  } finally {
    check("宿主干净退出", await stopSmokeHost(host, 30_000));
  }
}

let failure: unknown = null;
try {
  await loginItems.restoreAfter(() => main(executable));
} catch (error) {
  failure = error;
  check("中断", false, String(error).slice(0, 400));
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
  writeFileSync(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
const failed = report.checks.filter((c) => !c.passed);
process.stdout.write(
  `\n${report.checks.length - failed.length}/${report.checks.length} checks passed\n`,
);
if (failure !== null || failed.length > 0) process.exit(1);
