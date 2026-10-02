/**
 * 登录自启动烟测：按自启动登记的那条命令（--background --random-startup-delay）拉起原生 smoke 宿主，
 * 在时限内发布 daemon 描述符且服务健康，全程不建窗口，--smoke-quit 后干净退出。
 *
 * 时限 8 秒 = 宿主随机延迟上限 5 秒（app.rs STARTUP_DELAY_MAX_MS）+ core 冷启动余量。
 *
 *   pnpm smoke:startup
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeWindowProbe } from "./native-window.js";
import {
  CheckLog,
  delay,
  outputRoot,
  prepareSandbox,
  readRuntime,
  runtimeFile,
  smokeExecutable,
  sourceVersion,
  startSmokeHost,
  stopSmokeHost,
  snapshotLoginItems,
  exited,
  type SmokeRuntime,
} from "./smoke-host.js";

const executable = smokeExecutable();
const timeoutMs = 8_000;
const reportPath = join(outputRoot, "login-startup-smoke-report.json");
const log: CheckLog = new CheckLog();
const check: CheckLog["check"] = (name, condition, detail) => log.check(name, condition, detail);
const sandbox = await prepareSandbox("login-startup-smoke");
// 先拍 Run 快照，再起探针和宿主：读不到就什么都不启动。
const loginItems = snapshotLoginItems();
const probe = NativeWindowProbe.start();
// 先让探针编译好（Add-Type 要一两秒），免得这段时间被算进启动耗时。
await probe.windows(process.pid);

const startedAt = Date.now();
const host = startSmokeHost({
  executable,
  dataDir: sandbox.dataDir,
  env: sandbox.env,
  args: ["--background", "--random-startup-delay"],
});
let elapsedMs: number | null = null;
let runtime: SmokeRuntime | null = null;
let windowsSeen = 0;
let error: unknown;
try {
  await loginItems.restoreAfter(async () => {
    try {
      // 每一轮同时看描述符与窗口：随机延迟期间与服务起来以后都不许冒出应用窗口。
      while (Date.now() - startedAt < timeoutMs) {
        if (exited(host.child))
          throw new Error(
            `登录启动进程提前退出：${host.child.exitCode ?? host.child.signalCode}; ${host.stderr.join("")}`,
          );
        windowsSeen = Math.max(
          windowsSeen,
          (await probe.windows(host.pid)).filter((entry) => entry.visible).length,
        );
        runtime = await readRuntime(sandbox.dataDir).catch(() => null);
        if (runtime) break;
        await delay(50);
      }
      elapsedMs = Date.now() - startedAt;
      check(
        `登录启动在 ${timeoutMs}ms 内发布 daemon 描述符且服务健康`,
        runtime !== null,
        `${elapsedMs}ms ${host.stderr.join("")}`,
      );
      check(
        "服务版本是本次构建",
        runtime.version === sourceVersion,
        `${runtime.version} / ${sourceVersion}`,
      );
      const hostRecord = JSON.parse(
        readFileSync(join(sandbox.dataDir, "runtime", "host.json"), "utf8"),
      ) as { pid: number };
      check("host.json 记的是这个宿主", hostRecord.pid === host.pid, JSON.stringify(hostRecord));
      check("登录启动全程不建应用窗口", windowsSeen === 0, String(windowsSeen));
    } finally {
      log.record("--smoke-quit 干净退出", await stopSmokeHost(host), host.stderr.join(""));
      log.record("退出后运行时文件已清理", !existsSync(runtimeFile(sandbox.dataDir)));
    }
  });
} catch (caught) {
  error = caught;
} finally {
  probe.close();
}
const passed = error === undefined && log.failed.length === 0;
const report = {
  passed,
  executable,
  dataDir: sandbox.dataDir,
  elapsedMs,
  timeoutMs,
  version: (runtime as SmokeRuntime | null)?.version ?? null,
  background: true,
  randomDelay: true,
  completedAt: new Date().toISOString(),
  checks: log.checks,
  ...(error === undefined
    ? {}
    : { error: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!passed) process.exitCode = 1;
