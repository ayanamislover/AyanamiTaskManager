/**
 * lifecycle 冒烟（ATM 3 W5g；06 T-LIFE，方案 §5）：在 smoke 构建的开发版宿主上实测单元测试够不着的几条。
 *
 *   1. 干净退出：startup → ready → 心跳 → shutdown.begin → shutdown.complete → exit(clean)；下次启动不报异常。
 *   2. 被杀：下次启动报 previous.unclean，previousRunId 是被杀的那次。
 *   3. 会话结束（注销 / 关机，Windows 在退出链跑完之前结束进程）：下次报 previous.session-end，不算异常。
 *   4. 看门狗：事件循环停住、写线程卡在作业里，各自在阈值后记 watchdog.stall 并以退出码 3 结束进程；
 *      下次启动报 previous.unclean，previousEvent 是 watchdog.stall。
 *   5. 保活（W8c）：用户自己启动复位熔断（keepalive.reset + 通知）、清掉托盘退出标记；setup 的 QUIT
 *      不留标记，托盘「完全退出」留下这次登录的标记，后台启动不清它。
 *
 * 会话结束与两种挂住用 smoke 构建才认的管道命令（`--smoke-session-end`、`--smoke-stall-ui`、
 * `--smoke-stall-writer`）触发；阈值与心跳用 `ATM_SMOKE_WATCHDOG_MS` 调短（正式构建固定 120 s / 60 s）。
 * 环境只用合成的 LOCALAPPDATA（output/lifecycle-smoke-home），三个数据根变量都不传；结束时删掉沙箱。
 * 报告写 output/lifecycle-smoke-report.json。验红时用 ATM_SMOKE_HOST_EXE 指向放了漏洞的宿主（跳过构建）。
 *
 *   pnpm exec tsx scripts/lifecycle-smoke.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertSmokeHost } from "./package-native.js";
import {
  assertSandboxDataDir,
  CheckLog,
  delay,
  exited,
  killProcessTree,
  outputRoot,
  repoRoot,
  snapshotLoginItems,
  startSmokeHost,
  stopSmokeHost,
  waitUntil,
  type SmokeHost,
} from "./smoke-host.js";

const native = join(repoRoot, "apps", "desktop", "native");
const reportPath = join(outputRoot, "lifecycle-smoke-report.json");
const WATCHDOG_MS = 4_000;
const log: CheckLog = new CheckLog();
log.soft = true;

type Line = Record<string, unknown> & { event: string; runId: string };

function smokeHost(): string {
  const given = process.env.ATM_SMOKE_HOST_EXE;
  if (given === undefined) {
    const result = spawnSync(
      "cargo",
      ["build", "--locked", "-p", "atm-host", "--features", "smoke"],
      {
        cwd: native,
        env: { ...process.env, CARGO_TARGET_DIR: join(native, "target") },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    if (result.status !== 0) throw new Error(`cargo build 失败：${result.status}`);
  }
  const executable = resolve(given ?? join(native, "target", "debug", "AyanamiTaskManager.exe"));
  if (!existsSync(executable)) throw new Error(`找不到烟测宿主：${executable}`);
  assertSmokeHost(readFileSync(executable));
  return executable;
}

function sandbox(): { home: string; n: string; env: NodeJS.ProcessEnv } {
  const home = assertSandboxDataDir(join(outputRoot, "lifecycle-smoke-home"));
  rmSync(home, { recursive: true, force: true, maxRetries: 2 });
  mkdirSync(join(home, "Local"), { recursive: true });
  mkdirSync(join(home, "Roaming"), { recursive: true });
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM3_DATA_DIR"].includes(entry[0]),
    ),
  );
  return {
    home,
    n: join(home, "Local", "AyanamiTaskManager3"),
    env: {
      ...inherited,
      LOCALAPPDATA: join(home, "Local"),
      APPDATA: join(home, "Roaming"),
      ATM_SMOKE_CORE_USERPROFILE: home,
      ATM_DEV_REPOSITORY_ROOT: repoRoot,
      ATM_SMOKE_WATCHDOG_MS: String(WATCHDOG_MS),
    },
  };
}

function lines(n: string): Line[] {
  const path = join(n, "logs", "lifecycle.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Line);
}

/** 这个进程记的各条（按 pid 分；runId 由它的 startup 那条给出）。 */
function run(n: string, pid: number): Line[] {
  return lines(n).filter((line) => line.pid === pid);
}

function events(n: string, pid: number): string[] {
  return run(n, pid).map((line) => line.event);
}

async function waitFor(n: string, pid: number, event: string, timeoutMs = 60_000): Promise<Line> {
  return waitUntil(
    async () => run(n, pid).find((line) => line.event === event) ?? null,
    timeoutMs,
    `pid ${pid} 的 ${event}`,
  );
}

function exitCode(host: SmokeHost, timeoutMs: number): Promise<number | null> {
  return new Promise((done) => {
    if (exited(host.child)) return done(host.child.exitCode);
    const timer = setTimeout(() => done(null), timeoutMs);
    host.child.once("exit", (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
}

/** 给主实例发一条 smoke 管道命令（第二实例的进程很快退出）。 */
async function send(host: SmokeHost, flag: string): Promise<void> {
  const child = spawn(host.executable, [flag], {
    cwd: repoRoot,
    env: host.env,
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      child.kill();
      done();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
  });
}

function previousOf(n: string, pid: number): Line | undefined {
  return run(n, pid).find((line) => line.event.startsWith("previous."));
}

async function scenarios(executable: string, box: ReturnType<typeof sandbox>): Promise<void> {
  const { n } = box;

  // 1. 干净退出。
  const first = await start(executable, box);
  const firstRun = String((await waitFor(n, first.pid, "startup")).runId);
  // 等不到就让下面的检查记失败，不中断整轮（验红要看到落在哪一条上）。
  await waitFor(n, first.pid, "heartbeat", WATCHDOG_MS * 6).catch(() => undefined);
  const ready = run(n, first.pid).find((line) => line.event === "ready");
  log.check(
    "ready 带上 lease generation 与 instanceId",
    typeof ready?.generation === "number" && typeof ready?.instanceId === "string",
    JSON.stringify(ready),
  );
  const beat = run(n, first.pid).find((line) => line.event === "heartbeat");
  log.check("心跳带工作集大小", Number(beat?.rss) > 1024 * 1024, JSON.stringify(beat));
  log.check("--smoke-quit 干净退出", await stopSmokeHost(first));
  const firstEvents = events(n, first.pid);
  const tail = firstEvents.slice(-3);
  const exit = run(n, first.pid).at(-1);
  log.check(
    "干净退出的记录：shutdown.begin → shutdown.complete → exit(clean)",
    JSON.stringify(tail) === JSON.stringify(["shutdown.begin", "shutdown.complete", "exit"]) &&
      exit?.clean === true &&
      firstEvents[0] === "startup" &&
      run(n, first.pid).every((line) => line.runId === firstRun),
    firstEvents.join(" → "),
  );

  // 2. 干净退出之后不报异常；这一次被杀。
  const second = await start(executable, box);
  log.check(
    "干净退出之后的启动不报 previous.*",
    previousOf(n, second.pid) === undefined,
    JSON.stringify(previousOf(n, second.pid)),
  );
  const secondRun = String((await waitFor(n, second.pid, "startup")).runId);
  killProcessTree(second.pid);
  await exitCode(second, 15_000);

  // 3. 被杀之后：previous.unclean，指向被杀的那次。这一次会话结束。
  const third = await start(executable, box);
  const unclean = previousOf(n, third.pid);
  log.check(
    "被杀之后的启动报 previous.unclean，previousRunId 是被杀的那次",
    unclean?.event === "previous.unclean" &&
      unclean.previousRunId === secondRun &&
      unclean.previousPid === second.pid,
    JSON.stringify(unclean),
  );
  const thirdRun = String((await waitFor(n, third.pid, "startup")).runId);
  await send(third, "--smoke-session-end");
  const marked = await waitFor(n, third.pid, "session-end", 15_000).catch(() => undefined);
  log.check("会话结束：留下 session-end 标记", marked !== undefined);
  // Windows 在 WM_ENDSESSION 返回后立刻结束进程：这里同样不给退出链机会。
  killProcessTree(third.pid);
  await exitCode(third, 15_000);

  // 4. 会话结束之后：previous.session-end，不算异常。这一次让事件循环停住。
  const fourth = await start(executable, box);
  const ended = previousOf(n, fourth.pid);
  log.check(
    "会话结束之后的启动报 previous.session-end（不算异常）",
    ended?.event === "previous.session-end" && ended.previousRunId === thirdRun,
    JSON.stringify(ended),
  );
  const fourthRun = String((await waitFor(n, fourth.pid, "startup")).runId);
  await send(fourth, "--smoke-stall-ui");
  const uiCode = await exitCode(fourth, WATCHDOG_MS * 6);
  const uiStall = run(n, fourth.pid).find((line) => line.event === "watchdog.stall");
  log.check(
    "事件循环停住：看门狗记 watchdog.stall(event-loop) 并以退出码 3 结束进程",
    uiCode === 3 && uiStall?.reason === "event-loop" && Number(uiStall?.stalledMs) > WATCHDOG_MS,
    JSON.stringify({ uiCode, uiStall }),
  );
  if (!exited(fourth.child)) killProcessTree(fourth.pid);

  // 5. 看门狗结束之后：previous.unclean，previousEvent 是 watchdog.stall。这一次让写线程卡住。
  const fifth = await start(executable, box);
  const afterUi = previousOf(n, fifth.pid);
  log.check(
    "看门狗结束之后的启动报 previous.unclean（previousEvent=watchdog.stall）",
    afterUi?.event === "previous.unclean" &&
      afterUi.previousRunId === fourthRun &&
      afterUi.previousEvent === "watchdog.stall",
    JSON.stringify(afterUi),
  );
  const fifthRun = String((await waitFor(n, fifth.pid, "startup")).runId);
  await send(fifth, "--smoke-stall-writer");
  const writerCode = await exitCode(fifth, WATCHDOG_MS * 6);
  const writerStall = run(n, fifth.pid).find((line) => line.event === "watchdog.stall");
  log.check(
    "写线程卡住：看门狗记 watchdog.stall(writer) 并以退出码 3 结束进程",
    writerCode === 3 && writerStall?.reason === "writer",
    JSON.stringify({ writerCode, writerStall }),
  );
  if (!exited(fifth.child)) killProcessTree(fifth.pid);

  // 6. 收尾：再起一次，确认报的是写线程那次，然后干净退出。
  const sixth = await start(executable, box);
  const afterWriter = previousOf(n, sixth.pid);
  log.check(
    "写线程挂住之后的启动同样报 previous.unclean",
    afterWriter?.event === "previous.unclean" &&
      afterWriter.previousRunId === fifthRun &&
      afterWriter.previousEvent === "watchdog.stall",
    JSON.stringify(afterWriter),
  );
  log.check("最后一次 --smoke-quit 干净退出", await stopSmokeHost(sixth));
  await delay(200);
  await keepalive(executable, box);
}

/** 这次登录：`whoami /logonid` 的 `S-1-5-5-X-Y` 写成宿主记的样子（X、Y 各 8 位十六进制）。 */
function thisLogon(): string | null {
  const sid = spawnSync("whoami.exe", ["/logonid"], { encoding: "utf8", windowsHide: true })
    .stdout.trim()
    .match(/^S-1-5-5-(\d+)-(\d+)$/u);
  if (sid === null) return null;
  const hex = (part: string | undefined) => Number(part).toString(16).padStart(8, "0");
  return `${hex(sid[1])}${hex(sid[2])}`;
}

/**
 * 7. 保活（W8c，方案 §5、B1）：`user_quit` 只代表用户主动退出，熔断只由用户自己的启动复位。
 *    托盘「完全退出」与 setup 的 QUIT 都用真实的管道命令触发（`--smoke-tray-quit` 走托盘菜单的分支）。
 */
async function keepalive(executable: string, box: ReturnType<typeof sandbox>): Promise<void> {
  const { n } = box;
  const breakerPath = join(n, "runtime", "keepalive.json");
  const quitPath = join(n, "runtime", "user-quit.json");
  const now = Date.now();
  mkdirSync(join(n, "runtime"), { recursive: true });
  writeFileSync(
    breakerPath,
    JSON.stringify({
      exits: ["k1", "k2", "k3"].map((runId) => ({ runId, atMs: now })),
      trippedAtMs: now,
    }),
  );
  writeFileSync(quitPath, JSON.stringify({ logon: "another-logon", at: new Date().toISOString() }));

  // 用户自己启动（没有 --background）：熔断复位、记 keepalive.reset、弹通知；旧标记作废。
  const hostLog = () => readFileSync(join(n, "logs", "host.log"), "utf8");
  const toasts = () => (hostLog().match(/toast (shown|failed)/gu) ?? []).length;
  const toastsBefore = toasts();
  const user = await start(executable, box, []);
  const reset = run(n, user.pid).find((line) => line.event === "keepalive.reset");
  log.check(
    "用户自己启动：熔断复位并记 keepalive.reset(abnormalExits=3)",
    reset?.abnormalExits === 3 && !existsSync(breakerPath),
    JSON.stringify(reset),
  );
  log.check("用户自己启动：托盘退出标记作废", !existsSync(quitPath));
  log.check(
    "熔断复位的那次启动弹了通知（结果进 host.log）",
    toasts() === toastsBefore + 1,
    `${toastsBefore} → ${toasts()}`,
  );
  log.check(
    "keepalive.log 记下复位",
    readFileSync(join(n, "logs", "keepalive.log"), "utf8").includes(
      "Reset by the user's start (3 abnormal exits)",
    ),
  );

  // setup 的 QUIT：干净退出，不留标记。
  await send(user, "--smoke-setup-quit");
  const setupCode = await exitCode(user, 15_000);
  log.check(
    "setup 的 QUIT：干净退出，不留用户退出标记",
    setupCode === 0 && run(n, user.pid).at(-1)?.clean === true && !existsSync(quitPath),
    JSON.stringify({ setupCode, last: run(n, user.pid).at(-1) }),
  );

  // 托盘「完全退出」：干净退出，留下这次登录的标记。
  const tray = await start(executable, box);
  await send(tray, "--smoke-tray-quit");
  const trayCode = await exitCode(tray, 15_000);
  const marker = existsSync(quitPath)
    ? (JSON.parse(readFileSync(quitPath, "utf8")) as { logon?: unknown })
    : undefined;
  const logon = thisLogon();
  log.check(
    "托盘「完全退出」：干净退出，留下这次登录（登录 SID，同 whoami /logonid）的标记",
    trayCode === 0 &&
      run(n, tray.pid).at(-1)?.clean === true &&
      logon !== null &&
      marker?.logon === logon,
    JSON.stringify({ trayCode, marker, logon }),
  );

  // 登录自启与保活任务（--background）不是用户的意思：标记留着。
  const background = await start(executable, box);
  log.check("后台启动不清标记", existsSync(quitPath));
  log.check("后台启动的 --smoke-quit 干净退出", await stopSmokeHost(background));
  log.check("--smoke-quit 不留也不清标记", existsSync(quitPath));

  // 用户再启动一次：标记清掉；没熔断就不记 keepalive.reset。
  const again = await start(executable, box, []);
  log.check(
    "用户再启动：标记清掉，没熔断不记 keepalive.reset",
    !existsSync(quitPath) && !events(n, again.pid).includes("keepalive.reset"),
  );
  log.check("收尾的 --smoke-quit 干净退出", await stopSmokeHost(again));
  await delay(200);
}

const executable = smokeHost();
const box = sandbox();
// 先拍 Run 快照再启动宿主：读不到就什么都不启动；宿主改过的 Run 项最后照快照还原。
const loginItems = snapshotLoginItems([executable]);
let error: unknown;
try {
  await loginItems.restoreAfter(() => scenarios(executable, box));
} catch (caught) {
  error = caught;
}
const leaked = lines(box.n).some((line) =>
  JSON.stringify(line).match(/token|Bearer|[A-Za-z]:\\\\/u),
);
log.check("lifecycle 记录里没有令牌与本机路径", !leaked);
const passed = error === undefined && log.failed.length === 0;
const report = {
  passed,
  executable,
  completedAt: new Date().toISOString(),
  watchdogMs: WATCHDOG_MS,
  checks: log.checks,
  ...(error === undefined
    ? {}
    : { error: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
rmSync(box.home, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
if (!passed) process.exitCode = 1;

async function start(
  executable: string,
  box: ReturnType<typeof sandbox>,
  args?: string[],
): Promise<SmokeHost> {
  const host = startSmokeHost({
    executable,
    dataDir: box.n,
    env: box.env,
    ...(args === undefined ? {} : { args }),
  });
  await waitFor(box.n, host.pid, "ready", 120_000);
  return host;
}
