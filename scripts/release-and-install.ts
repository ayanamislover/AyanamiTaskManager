/**
 * 一条命令走完：升版本号 → 十阶段流水线 → 投递更新 → 就地应用 → 对运行实例实测。
 *
 * 常规改动不再卸载重装：distribution-smoke 验的是安装器本身，它的依赖没变时会被
 * 复用，于是整套清场可以跳过，Squirrel 直接把新版本铺到 app-<version>。只有碰了
 * 打包配置、发布脚本、原生依赖或迁移，才会退回「清场 + 全量验收」。
 *
 * 必须在能真实写入 %LOCALAPPDATA% 的终端里跑。Agent 的 Bash 工具对该路径的
 * 创建会落进只有它自己看得见的覆盖层（删除却是穿透的），安装看起来成功、实际
 * 没落盘；PowerShell 工具与真实磁盘一致。详见 ATM-R-067。
 *
 *   pnpm exec tsx scripts/release-and-install.ts --version 1.0.6
 *   pnpm exec tsx scripts/release-and-install.ts            # 不升版，重打当前版本
 *   ... --skip-install                                      # 只跑到产出 release/
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assertSafeInstallRoot, removeProductShortcuts } from "./product-install-sites.js";
import {
  computeReleaseFingerprint,
  decideStageReuse,
  type ReleaseFingerprint,
} from "./release-fingerprint.js";
import {
  bumpVersion,
  findVersionLeftovers,
  resetReleaseChecklist,
  VERSIONED_FILES,
} from "./version-sites.js";

const root = resolve(process.cwd());
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

function step(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function run(command: string, commandArgs: string[], options: { cwd?: string } = {}): number {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? root,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function git(commandArgs: string[]): string {
  const result = spawnSync("git", commandArgs, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${commandArgs.join(" ")} 失败`);
  return result.stdout;
}

// 发布是从工作树打包的，不是从 HEAD。工作树里若有别人未提交的改动，会被一起
// 打进产物——前几轮都是靠人工 stash 才躲开的，这里直接拒绝。
const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"]).trim();
if (dirty && !flag("allow-dirty")) {
  process.stderr.write(
    `工作树不干净，拒绝发布（发布从工作树打包，会把这些改动一起打进产物）：\n${dirty}\n` +
      `先提交或 git stash，或明确加 --allow-dirty。\n`,
  );
  process.exit(2);
}

const packageJsonPath = join(root, "package.json");
const currentVersion = JSON.parse(readFileSync(packageJsonPath, "utf8")).version as string;
const target = value("version") ?? currentVersion;

if (target !== currentVersion) {
  step(`升版本号 ${currentVersion} → ${target}`);
  const changed = bumpVersion(root, currentVersion, target);
  try {
    for (const file of VERSIONED_FILES) {
      if (!changed.includes(file))
        throw new Error(`VERSION_SITE_MISSED: ${file} 里没有找到 ${currentVersion}`);
      process.stdout.write(`  ${file}\n`);
    }
    // 漏改一处版本号，Squirrel 会拿同名不同哈希的包当升级处理，装出来的还是旧版。
    const leftovers = findVersionLeftovers(currentVersion);
    if (leftovers.length > 0) {
      throw new Error(`VERSION_LEFTOVER: 代码里仍有 ${currentVersion}\n${leftovers.join("\n")}`);
    }
  } catch (error) {
    // 升版失败就把版本号退回去。半升的工作树会让下一次运行卡在「工作树不干净」，
    // 而那些改动是脚本自己留下的，人还得先分辨一遍哪些是自己的。
    bumpVersion(root, target, currentVersion);
    throw error;
  }
  resetReleaseChecklist(root, currentVersion, target);
  process.stdout.write(`  docs/release-checklist.md：勾选已重置、验收结果已清空待填\n`);
}

const setupName = `AyanamiTaskManager-Setup-${target}-win-x64.exe`;
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("LOCALAPPDATA_MISSING");
// 收窄后再固化一次：闭包里 TS 不保留顶层的 narrowing。
const localAppDataRoot: string = localAppData;
const installRoot = join(localAppData, "AyanamiTaskManagerDesktop");

function appProcesses(): number[] {
  const result = spawnSync(
    "tasklist.exe",
    ["/fo", "csv", "/nh", "/fi", "IMAGENAME eq AyanamiTaskManager.exe"],
    { encoding: "utf8", windowsHide: true },
  );
  return (result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => /^"[^"]+","(\d+)"/u.exec(line.trim())?.[1])
    .filter((pid): pid is string => Boolean(pid))
    .map(Number);
}

// distribution-smoke 的前置条件要求「没有已安装版本、没有同名进程」，所以只有
// 它真要跑时才需要清场。它的依赖没变（没碰打包配置、发布脚本、原生依赖、迁移）
// 时会被复用，这一整套卸载重装就可以整个跳过——应用全程活着，靠 feed 自更新。
const previousReport = join(root, "output", "release-verification.json");
const previousRun = existsSync(previousReport)
  ? (JSON.parse(readFileSync(previousReport, "utf8")) as {
      fingerprint?: ReleaseFingerprint;
      commands?: Array<{ name: string; exitCode: number }>;
    })
  : null;
const distributionSmoke = decideStageReuse(
  "distribution-smoke",
  previousRun?.fingerprint,
  await computeReleaseFingerprint(root),
  previousRun?.commands?.find((command) => command.name === "distribution-smoke")?.exitCode,
);
const needsCleanRoom = !distributionSmoke.reuse;

if (!needsCleanRoom) {
  step("跳过清场");
  process.stdout.write(
    `  distribution-smoke 的输入没变（${distributionSmoke.reason}），本轮复用上次结果。\n` +
      `  不卸载、不杀进程：应用保持运行，更新通过 feed 生效。\n`,
  );
}

async function clearInstallation(): Promise<void> {
  step("清场：关闭同名进程并卸载旧版");
  // MCP stdio 桥用的是同一个 exe 名，退出桌面应用不会带走它们；它们还占着安装
  // 目录里的 exe 句柄，不杀干净 Squirrel 只能留下 .dead 标记。
  const running = appProcesses();
  if (running.length > 0) {
    process.stdout.write(
      `  结束 ${running.length} 个 AyanamiTaskManager.exe（含 MCP stdio 桥）：${running.join("、")}\n`,
    );
    for (const pid of running)
      spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true });
    await sleep(1200);
  }
  const updater = join(installRoot, "Update.exe");
  if (existsSync(updater)) {
    process.stdout.write("  Squirrel 静默卸载\n");
    run(updater, ["--uninstall", "-s"]);
    await sleep(3000);
    for (const pid of appProcesses())
      spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true });
  } else {
    process.stdout.write("  没有已安装版本，跳过\n");
  }

  // Squirrel 静默卸载会留下开始菜单快捷方式、.dead 标记和半个 app-<version> 目录。
  // distribution-smoke 的前置条件要求这些全都不在，否则跑完九个阶段才在第十阶段
  // 倒掉——1.0.5 就白跑了一轮。清理位置与它共用 product-install-sites。
  const strandedShortcuts = await removeProductShortcuts();
  if (strandedShortcuts.length > 0) {
    process.stdout.write(`  清理残留快捷方式 ${strandedShortcuts.length} 个\n`);
  }
  if (existsSync(installRoot)) {
    assertSafeInstallRoot(installRoot, localAppDataRoot);
    if (appProcesses().length > 0) {
      throw new Error(`INSTALL_ROOT_BUSY: 仍有同名进程占用 ${installRoot}`);
    }
    await rm(installRoot, { recursive: true, force: true });
    process.stdout.write(`  清理卸载残留目录：${installRoot}\n`);
  }
}

if (needsCleanRoom) await clearInstallation();

step("十阶段流水线");
const releaseExit = run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm release"]);
if (releaseExit !== 0) {
  process.stderr.write(`\npnpm release 退出码 ${releaseExit}，中止。\n`);
  process.exit(releaseExit);
}

const setup = join(root, "release", setupName);
if (!existsSync(setup)) throw new Error(`SETUP_MISSING: ${setup}`);
if (flag("skip-install")) {
  process.stdout.write(`\n产物就绪：${setup}\n（--skip-install，未安装）\n`);
  process.exit(0);
}

// 更新源是一个本地目录，不是服务器。169 MB 在本机是一次文件复制而不是一次网络
// 下载，所以不需要 delta 包——delta 是为跨机分发省流量的。
step("投递更新到本地 feed");
const feed = join(localAppData, "AyanamiTaskManager", "updates");
mkdirSync(feed, { recursive: true });
const squirrelOut = join(root, "out", "make", "squirrel.windows", "x64");
for (const name of ["RELEASES", `AyanamiTaskManagerDesktop-${target}-full.nupkg`]) {
  const source = join(squirrelOut, name);
  if (!existsSync(source)) throw new Error(`FEED_SOURCE_MISSING: ${source}`);
  copyFileSync(source, join(feed, name));
  process.stdout.write(`  ${name}\n`);
}

const alreadyInstalled = existsSync(join(installRoot, "Update.exe"));
if (!alreadyInstalled) {
  step(`首次安装 ${setupName}`);
  const install = run(setup, ["--silent"]);
  if (install !== 0) throw new Error(`SETUP_EXIT: ${install}`);
} else {
  // 已经装过就不再卸载重装：让 Squirrel 就地把新版本铺到 app-<version>。
  // 运行中的应用自己也会在 6 小时内或下次启动时发现，这里主动应用只是为了
  // 让这条命令结束时就能对新版本做实测。
  step("就地应用更新");
  const applied = run(join(installRoot, "Update.exe"), ["--update", feed]);
  if (applied !== 0) throw new Error(`UPDATE_EXIT: ${applied}`);
}
for (let i = 0; i < 60 && !existsSync(join(installRoot, `app-${target}`)); i += 1)
  await sleep(1000);
if (!existsSync(join(installRoot, `app-${target}`)))
  throw new Error(`INSTALL_DIR_MISSING: app-${target}`);

// 启动壳始终拉最新的 app-<version>，但已经在跑的进程仍是旧版，MCP stdio 桥也
// 一样（它们是各 Agent 拉起的独立进程，用同一个 exe 名）。要让实测打在新版本
// 上，就得先把它们全带走。
const stale = appProcesses();
if (stale.length > 0) {
  process.stdout.write(`  结束 ${stale.length} 个旧版进程（含 MCP stdio 桥）\n`);
  for (const pid of stale)
    spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true });
  await sleep(1500);
}

step("启动并对运行实例实测");
spawn(join(installRoot, "AyanamiTaskManager.exe"), [], { detached: true, stdio: "ignore" }).unref();
const runtimePath = join(localAppData, "AyanamiTaskManager", "runtime", "daemon.json");
let status: Record<string, unknown> | null = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(1000);
  if (!existsSync(runtimePath)) continue;
  try {
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      endpoint: string;
      token: string;
    };
    const response = await fetch(`${runtime.endpoint}/api/v1/system/status`, {
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    if (!response.ok) continue;
    status = (await response.json()) as Record<string, unknown>;
    break;
  } catch {
    // daemon 还没起来
  }
}
if (!status) throw new Error("DAEMON_UNREACHABLE");
if (status.version !== target)
  throw new Error(`VERSION_MISMATCH: 运行实例报 ${String(status.version)}，期望 ${target}`);

const summary = {
  version: target,
  commit: git(["rev-parse", "HEAD"]).trim(),
  setup,
  status,
  completedAt: new Date().toISOString(),
};
writeFileSync(
  join(root, "output", "release-and-install.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  `\n完成：${target} 已安装并在运行，system/status 报 version=${String(status.version)}、ok=${String(status.ok)}、projectCount=${String(status.projectCount)}\n`,
);
