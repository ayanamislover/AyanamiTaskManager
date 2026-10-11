/**
 * 发布阶段 10：用**生产二进制**验收发出去的两种形态（de-electron §9「最终候选单独跑」）。
 *
 * packaged-smoke 验行为，用的是带 smoke feature 的测试宿主（能开 CDP、接受烟测专用的退出命令）；
 * 这里验的是用户真正拿到的那份：
 *
 *   便携 zip   解压 → 启动 → 服务健康 → SHOW 后窗口与 WebView 起来 → 注入的 WebView2 调试参数
 *              与用户数据目录被宿主清掉，没有调试端口。L 与 N 都在 output/ 下，在哪台机器上都能跑，
 *              跑完核对真实的 N 没被碰过。
 *   安装包     见 distribution-installed.ts：写真实的卸载项、开始菜单与任务计划程序，只在干净机器上跑。
 *              没有 ATM_DISTRIBUTION_CLEAN_MACHINE=1 的声明就不跑，报告记 installed: "skipped"，
 *              不写 installed 报告——INSTALLED 层随之缺席。CI 的发布验证每次都是新机器，在那里声明。
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  appProcesses,
  check,
  checks,
  installRoot,
  killTree,
  outputRoot,
  packageDir,
  packageVersion,
  productionChecks,
  realN,
  reportPath,
  run,
  waitUntil,
  writeSmokeReport,
} from "./distribution-common.js";
import { portableZipName } from "./package-native.js";
import { resolveSystemTar } from "./system-tar.js";

const cleanMachine = process.env.ATM_DISTRIBUTION_CLEAN_MACHINE === "1";

/** 真实 N 里宿主记下的 pid（没有 N 或没有 host.json 是 null）。 */
function realHostPid(): number | null {
  const file = join(realN, "runtime", "host.json");
  if (!existsSync(file)) return null;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid;
  } catch {
    return null;
  }
}

async function portable(): Promise<void> {
  const from = checks.length;
  const zip = join(packageDir, portableZipName(packageVersion));
  check("便携 zip 存在", existsSync(zip), zip);
  const portableRoot = join(outputRoot, "portable");
  await mkdir(portableRoot, { recursive: true });
  check("便携 zip 可解压", run(resolveSystemTar(), ["-xf", zip, "-C", portableRoot]) === 0, zip);
  const appDir = join(portableRoot, `AyanamiTaskManager-${packageVersion}`);
  const executable = join(appDir, "AyanamiTaskManager.exe");
  const marker = join(appDir, "portable");
  check(
    "便携目录带 portable 标记，写着本次版本",
    existsSync(marker) && readFileSync(marker, "utf8").trim() === packageVersion,
    marker,
  );
  const dataDir = join(outputRoot, "portable-data");
  const roots = { l: join(dataDir, "L"), n: join(dataDir, "N") };
  const realNBefore = existsSync(realN);
  const { hostPid } = await productionChecks("portable", executable, roots);
  check(
    "便携：运行落在隔离的 3.0 根，真实的 N 没被碰过",
    existsSync(join(roots.n, "runtime", "host.json")) &&
      (realNBefore || !existsSync(realN)) &&
      realHostPid() !== hostPid,
    `${roots.n}; real ${realN}`,
  );
  // 生产宿主没有 SMOKE_QUIT；干净退出由 packaged-smoke 验，这里按进程树结束。
  killTree(hostPid);
  check(
    "便携：结束后没有残留进程",
    await waitUntil(async () =>
      appProcesses().every((entry) => entry.pid !== hostPid) ? true : null,
    ),
    String(hostPid),
  );
  await writeSmokeReport("portable", dataDir, from);
}

/** 安装那一半：只在声明了干净机器时加载；否则记跳过，什么都不碰。 */
async function installedHalf(): Promise<"verified" | "skipped"> {
  if (!cleanMachine) {
    checks.push({
      name: "安装验收只在干净机器上跑：没有 ATM_DISTRIBUTION_CLEAN_MACHINE=1，跳过",
      passed: true,
      detail: installRoot,
    });
    return "skipped";
  }
  const { installed } = await import("./distribution-installed.js");
  return installed();
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
let installedState: "verified" | "skipped" | null = null;
try {
  await portable();
  installedState = await installedHalf();
  const report = {
    passed: true,
    completedAt: new Date().toISOString(),
    packageDir,
    installRoot,
    installed: installedState,
    checks,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const report = {
    passed: false,
    completedAt: new Date().toISOString(),
    packageDir,
    installRoot,
    installed: installedState,
    checks,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  throw error;
}
