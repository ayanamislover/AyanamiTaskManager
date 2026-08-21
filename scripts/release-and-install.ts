/**
 * 一条命令走完：升版本号 → 十阶段流水线 → 卸载旧版 → 安装新版 → 对运行实例实测。
 *
 * 必须在能真实写入 %LOCALAPPDATA% 的终端里跑。Agent 的 Bash 工具对该路径的
 * 创建会落进只有它自己看得见的覆盖层（删除却是穿透的），安装看起来成功、实际
 * 没落盘；PowerShell 工具与真实磁盘一致。详见 ATM-R-067。
 *
 *   pnpm exec tsx scripts/release-and-install.ts --version 1.0.5
 *   pnpm exec tsx scripts/release-and-install.ts            # 不升版，重打当前版本
 *   ... --skip-install                                      # 只跑到产出 release/
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assertSafeInstallRoot, removeProductShortcuts } from "./product-install-sites.js";
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
  assertSafeInstallRoot(installRoot, localAppData);
  if (appProcesses().length > 0) {
    throw new Error(`INSTALL_ROOT_BUSY: 仍有同名进程占用 ${installRoot}`);
  }
  await rm(installRoot, { recursive: true, force: true });
  process.stdout.write(`  清理卸载残留目录：${installRoot}\n`);
}

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

step(`安装 ${setupName}`);
const install = run(setup, ["--silent"]);
if (install !== 0) throw new Error(`SETUP_EXIT: ${install}`);
for (let i = 0; i < 60 && !existsSync(join(installRoot, `app-${target}`)); i += 1)
  await sleep(1000);
if (!existsSync(join(installRoot, `app-${target}`)))
  throw new Error(`INSTALL_DIR_MISSING: app-${target}`);

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
