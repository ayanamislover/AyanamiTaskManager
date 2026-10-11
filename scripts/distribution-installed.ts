/**
 * distribution-smoke 的安装那一半：atm-setup.exe install → 登记（app.json、current、卸载项、开始菜单与
 * 「ATM 修复」、保活计划任务）→ 生产二进制的运行检查与界面就绪见证 → --uninstall → 登记全部撤掉、
 * 用户数据保留。
 *
 * 它写真实的 HKCU 卸载项、开始菜单与**真实的任务计划程序**（3.0 的保活任务），没法隔离到沙箱里：
 * 生产 setup 不认演练的沙箱（那是 install-drill 用 drill 构建验的）。所以只在干净机器上跑——
 * 调用方先要 ATM_DISTRIBUTION_CLEAN_MACHINE=1 的声明，这里再逐项核对机器确实干净，有任何一样
 * 产品痕迹（两个数据根、安装根、卸载项、自启值、保活任务、运行中的进程、快捷方式）就拒绝。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeAppProcesses } from "./app-processes.js";
import {
  appProcesses,
  check,
  checks,
  hostEnvironment,
  installRoot,
  localAppDataRoot,
  packageDir,
  packageVersion,
  productionChecks,
  realL,
  realN,
  run,
  waitUntil,
  writeSmokeReport,
} from "./distribution-common.js";
import {
  applyRunRestore,
  findRunEntry,
  loginItemRestorePlan,
  readRunSnapshot,
  RUN_VALUE,
} from "./login-item-guard.js";
import {
  assertSafeInstallRoot as assertInstallRootIsProduct,
  findProductShortcuts,
} from "./product-install-sites.js";

const uninstallRegistryKey =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AyanamiTaskManagerDesktop";
/** 保活任务名：与 install-state/src/keepalive.rs 的 `TASK_NAME` 同一个（有用例钉住）。 */
export const KEEPALIVE_TASK = "AyanamiTaskManager 保活";

function uninstallRegistrationExists(): boolean {
  const result = spawnSync("reg.exe", ["query", uninstallRegistryKey], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`reg.exe query 退出码 ${result.status}`);
}

/** 保活任务的定义（XML）；没有登记是 null。只读查询，不改计划任务。 */
function keepaliveTask(): string | null {
  const result = spawnSync("schtasks.exe", ["/query", "/tn", KEEPALIVE_TASK, "/xml"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout;
  if (result.status === 1) return null;
  throw new Error(`schtasks.exe /query 退出码 ${result.status}`);
}

export async function installed(): Promise<"verified"> {
  // 自启登记的值名与真实安装共用：验收前已有这个值（哪怕指向便携版），安装会改写、卸载会删，
  // 事后分不清是卸载删的还是用户期间删的。和同名安装一样，有就不做安装验收。
  const runBefore = readRunSnapshot();
  const traces = [
    existsSync(realL) && realL,
    existsSync(realN) && realN,
    existsSync(join(installRoot, "app.json")) && join(installRoot, "app.json"),
    existsSync(join(installRoot, "Update.exe")) && join(installRoot, "Update.exe"),
    uninstallRegistrationExists() && uninstallRegistryKey,
    findRunEntry(runBefore, RUN_VALUE) !== undefined && `Run ${RUN_VALUE}`,
    keepaliveTask() !== null && `计划任务 ${KEEPALIVE_TASK}`,
  ].filter((trace): trace is string => typeof trace === "string");
  assertInstallRootIsProduct(installRoot, localAppDataRoot);
  check(
    "验收前机器干净：没有产品数据、安装、登记与保活任务",
    traces.length === 0,
    traces.join("; "),
  );
  const running = appProcesses();
  check("验收前没有运行中的同名进程", running.length === 0, describeAppProcesses(running));
  const priorShortcuts = await findProductShortcuts();
  check("验收前没有同名产品快捷方式", priorShortcuts.length === 0, priorShortcuts.join(", "));

  const from = checks.length;
  const manifest = join(packageDir, `atm-${packageVersion}-win-x64.json`);
  const setup = join(packageDir, "atm-setup.exe");
  // 产品默认的根：干净机器上就是这次安装自己建的。
  const env = hostEnvironment({ l: null, n: realN });
  try {
    check("atm-setup 静默安装", run(setup, ["install", manifest, "--quiet"], env) === 0, manifest);
    const pointer = JSON.parse(await readFile(join(installRoot, "app.json"), "utf8")) as {
      current: string;
    };
    check("app.json 指向本次版本", pointer.current === packageVersion, pointer.current);
    check("卸载注册项已创建", uninstallRegistrationExists(), uninstallRegistryKey);
    const shortcuts = await findProductShortcuts();
    check(
      "开始菜单有应用与「ATM 修复」",
      shortcuts.length >= 2 && shortcuts.some((path) => path.includes("修复")),
      shortcuts.join(", "),
    );
    const launcher = join(installRoot, "AyanamiTaskManager.exe");
    check("安装根有启动器", existsSync(launcher), launcher);
    const task = keepaliveTask();
    check(
      "保活任务已登记：安装根的启动器 --ensure-running",
      task !== null &&
        task.toLowerCase().includes(launcher.toLowerCase()) &&
        task.includes("--ensure-running"),
      task ?? "(none)",
    );
    await productionChecks("installed", launcher, { l: null, n: realN });
    check(
      "界面就绪见证已写（renderer 真加载了）",
      await waitUntil(async () =>
        existsSync(join(installRoot, "state", "health", `ui-${packageVersion}.json`)) ? true : null,
      ),
      join(installRoot, "state", "health"),
    );

    const preservedMarker = join(realN, "uninstall-preservation.marker");
    await writeFile(preservedMarker, "AyanamiTaskManager user data preservation proof\n", "utf8");
    check(
      "atm-setup 静默卸载",
      run(join(installRoot, "atm-setup.exe"), ["--uninstall", "--quiet"], env) === 0,
    );
    // 安装根里的 setup 删不掉正在运行的自己：它把卸载交给 %TEMP% 里的副本继续做，自己先返回。
    await waitUntil(
      async () =>
        (!existsSync(installRoot) || (await readdir(installRoot)).length === 0) &&
        !uninstallRegistrationExists() &&
        appProcesses().length === 0
          ? true
          : null,
      120_000,
    );
    const left = appProcesses();
    check("卸载后应用进程已退出", left.length === 0, describeAppProcesses(left));
    check("卸载后卸载注册项已移除", !uninstallRegistrationExists(), uninstallRegistryKey);
    check("卸载后保活任务已移除", keepaliveTask() === null, KEEPALIVE_TASK);
    const remaining = await findProductShortcuts();
    check("卸载后产品快捷方式已移除", remaining.length === 0, remaining.join(", "));
    check(
      "卸载后安装根已清空",
      !existsSync(installRoot) || (await readdir(installRoot)).length === 0,
      installRoot,
    );
    check("卸载后用户数据仍保留", existsSync(preservedMarker), preservedMarker);
    await writeSmokeReport("installed", realN, from);
    return "verified";
  } finally {
    // 安装写的自启指向安装根的启动器（现值还指向它就是本轮写的）；卸载删掉的是上面记下的那些名字。
    applyRunRestore(
      loginItemRestorePlan(runBefore, readRunSnapshot(), {
        executables: [join(installRoot, "AyanamiTaskManager.exe")],
        // 验收前没有这个值，就没有要放回的：只删本轮安装新加、仍指向本轮启动器的。
        deleted: [],
      }),
    );
  }
}
