/**
 * 一条命令走完：升版本号 → 十阶段流水线 → 投递更新 → 就地应用 → 对运行实例实测。
 *
 * 默认走清场和全量验收。只有显式 --resume 且上一轮完整 release fingerprint
 * （含 stageHashes 完整键集和值）逐字段相同时，才允许沿用已通过的旧证据并跳过
 * distribution-smoke 清场；局部阶段哈希绝不构成稳定签发授权。
 *
 * 必须在能真实写入 %LOCALAPPDATA% 的终端里跑。Agent 的 Bash 工具对该路径的
 * 创建会落进只有它自己看得见的覆盖层（删除却是穿透的），安装看起来成功、实际
 * 没落盘；PowerShell 工具与真实磁盘一致。详见 ATM-R-067。
 *
 *   pnpm exec tsx scripts/release-and-install.ts --version 1.0.6
 *   pnpm exec tsx scripts/release-and-install.ts            # 不升版，重打当前版本
 *   ... --resume                                             # 仅完整指纹命中时复用
 *   ... --skip-install                                      # 只跑到产出 release/
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  assertReleaseArtifact,
  assertReleaseResumeEvidence,
  releaseResumeEvidencePaths,
  type ReleaseResumeEvidenceManifest,
} from "./release-artifact-evidence.js";
import {
  assertSafeInstallRoot,
  clearStaleDeadMarker,
  removeProductShortcuts,
} from "./product-install-sites.js";
import { pruneUpdateFeed, updateFeedDir } from "./update-feed.js";
import {
  commitReleasePreparation,
  computeReleaseFingerprint,
  decideReleaseResume,
  releaseFingerprintsMatch,
  selectReusableReleaseCommands,
  type ReleaseFingerprint,
} from "./release-fingerprint.js";
import { assertReleaseCandidateIdentity, type ReleaseCandidateIdentity } from "./release-report.js";
import {
  assertReleaseChecklistIsDynamic,
  bumpVersion,
  findVersionLeftovers,
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
if (dirty) {
  process.stderr.write(
    `工作树不干净，拒绝发布（发布从工作树打包，会把这些改动一起打进产物）：\n${dirty}\n` +
      `先提交或 git stash。正式产物必须能从 release.json 声明的 clean HEAD 重建。\n`,
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
  assertReleaseChecklistIsDynamic(root);
  process.stdout.write(`  docs/release-checklist.md：动态证据清单契约通过\n`);
  const releaseHead = commitReleasePreparation(root, target, [...VERSIONED_FILES]);
  process.stdout.write(`  发布准备已提交到 clean HEAD：${releaseHead}\n`);
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

// distribution-smoke 的前置条件要求「没有已安装版本、没有同名进程」。稳定签发
// 只有显式 --resume 且完整 fingerprint 命中已通过报告时才能沿用这份证据；局部
// stageHash 相同不构成跳过清场或稳定签发验证的授权。
const previousReport = join(root, "output", "release-verification.json");
const previousRun = existsSync(previousReport)
  ? (JSON.parse(readFileSync(previousReport, "utf8")) as {
      passed?: boolean;
      fingerprint?: ReleaseFingerprint;
      commands?: Array<{ name: string; exitCode: number; log: string }>;
    })
  : null;
const releaseFingerprint = await computeReleaseFingerprint(root);
const releaseResume = decideReleaseResume(
  flag("resume"),
  previousRun?.fingerprint,
  releaseFingerprint,
);
const reusableReleaseCommands = selectReusableReleaseCommands(releaseResume, previousRun?.commands);
let resumeEvidenceValid = false;
if (releaseResume.reuse) {
  try {
    const resumeManifest = JSON.parse(
      readFileSync(join(root, "output", "release-resume-evidence.json"), "utf8"),
    ) as ReleaseResumeEvidenceManifest;
    await assertReleaseResumeEvidence(
      root,
      resumeManifest,
      releaseFingerprint,
      releaseResumeEvidencePaths(resumeManifest.candidate, previousRun?.commands ?? []),
    );
    resumeEvidenceValid = true;
  } catch {
    // release.ts 会输出具体的有界拒绝原因；这里保守清场，避免先跳过再被迫全跑。
  }
}
const canReuseDistributionSmoke =
  resumeEvidenceValid &&
  previousRun?.passed === true &&
  reusableReleaseCommands.has("distribution-smoke");
const needsCleanRoom = !canReuseDistributionSmoke;

if (!needsCleanRoom) {
  step("跳过清场");
  process.stdout.write(
    `  完整 fingerprint 命中（${releaseResume.reason}），复用已通过的 distribution-smoke 稳定签发证据。\n` +
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
const releaseCommand = flag("resume")
  ? "pnpm exec tsx scripts/release.ts --resume"
  : "pnpm exec tsx scripts/release.ts";
const releaseExit = run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", releaseCommand]);
if (releaseExit !== 0) {
  process.stderr.write(`\npnpm release 退出码 ${releaseExit}，中止。\n`);
  process.exit(releaseExit);
}

const releaseManifestPath = join(root, "release", "release.json");
const releaseManifest = JSON.parse(readFileSync(releaseManifestPath, "utf8")) as {
  version?: string;
  candidate: ReleaseCandidateIdentity;
};
assertReleaseCandidateIdentity(releaseManifest.candidate);
if (
  releaseManifest.version !== target ||
  releaseManifest.candidate.version !== target ||
  !releaseFingerprintsMatch(releaseManifest.candidate.fingerprint, releaseFingerprint)
) {
  throw new Error("RELEASE_MANIFEST_CANDIDATE_MISMATCH");
}
const candidate = releaseManifest.candidate;
const setup = join(root, "release", candidate.artifacts.setup.name);
const portable = join(root, "release", candidate.artifacts.portable.name);
const upgradePackage = join(root, "release", candidate.artifacts.upgradePackage.name);
const releases = join(root, "release", candidate.artifacts.releases.name);
if (candidate.artifacts.setup.name !== setupName) {
  throw new Error(`SETUP_MANIFEST_NAME_MISMATCH: ${candidate.artifacts.setup.name}`);
}
if (candidate.artifacts.portable.name !== `AyanamiTaskManager-${target}-win-x64-portable.zip`) {
  throw new Error(`PORTABLE_MANIFEST_NAME_MISMATCH: ${candidate.artifacts.portable.name}`);
}
if (candidate.artifacts.upgradePackage.name !== `AyanamiTaskManagerDesktop-${target}-full.nupkg`) {
  throw new Error(`NUPKG_MANIFEST_NAME_MISMATCH: ${candidate.artifacts.upgradePackage.name}`);
}
if (candidate.artifacts.releases.name !== "RELEASES") {
  throw new Error(`RELEASES_MANIFEST_NAME_MISMATCH: ${candidate.artifacts.releases.name}`);
}
await Promise.all([
  assertReleaseArtifact(setup, candidate.artifacts.setup),
  assertReleaseArtifact(portable, candidate.artifacts.portable),
  assertReleaseArtifact(upgradePackage, candidate.artifacts.upgradePackage),
  assertReleaseArtifact(releases, candidate.artifacts.releases),
]);
if (flag("skip-install")) {
  process.stdout.write(`\n产物就绪：${setup}\n（--skip-install，未安装）\n`);
  process.exit(0);
}

// 更新源是一个本地目录，不是服务器。169 MB 在本机是一次文件复制而不是一次网络
// 下载，所以不需要 delta 包——delta 是为跨机分发省流量的。
step("投递更新到本地 feed");
const feed = updateFeedDir(join(localAppData, "AyanamiTaskManager"));
mkdirSync(feed, { recursive: true });
for (const artifact of [candidate.artifacts.releases, candidate.artifacts.upgradePackage]) {
  const source = join(root, "release", artifact.name);
  const destination = join(feed, artifact.name);
  copyFileSync(source, destination);
  await assertReleaseArtifact(destination, artifact);
  process.stdout.write(`  ${artifact.name}\n`);
}
// 投递之后才清：RELEASES 这时已经换成新的，旧包到这一刻才真正没人要了。
const staleFeedPackages = pruneUpdateFeed(feed);
if (staleFeedPackages.length > 0) {
  process.stdout.write(`  清理 ${staleFeedPackages.length} 个 RELEASES 未列出的旧包\n`);
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
// distribution-smoke 走完一整轮装—验—卸后会留下 .dead，紧接着的就地更新把
// app-<version> 铺回来却不清它，于是「已卸载」标记贴在活着的安装上。
if (clearStaleDeadMarker(installRoot, target)) {
  process.stdout.write("  清除烟测遗留的 .dead 标记\n");
}

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
if (status.ok !== true) throw new Error(`DAEMON_STATUS_NOT_OK: ${String(status.ok)}`);
if (status.version !== target)
  throw new Error(`VERSION_MISMATCH: 运行实例报 ${String(status.version)}，期望 ${target}`);

const finalFingerprint = await computeReleaseFingerprint(root);
if (
  !releaseFingerprintsMatch(releaseFingerprint, finalFingerprint) ||
  !releaseFingerprintsMatch(candidate.fingerprint, finalFingerprint)
) {
  throw new Error("RELEASE_SOURCE_CHANGED_DURING_INSTALLATION");
}
const verifiedAt = new Date().toISOString();
const projectCount =
  typeof status.projectCount === "number" && Number.isSafeInteger(status.projectCount)
    ? status.projectCount
    : null;
const summary = {
  schemaVersion: 3,
  candidateSha256: candidate.candidateSha256,
  version: target,
  gitHead: candidate.gitHead,
  setupSha256: candidate.artifacts.setup.sha256,
  portableSha256: candidate.artifacts.portable.sha256,
  upgradePackageSha256: candidate.artifacts.upgradePackage.sha256,
  releasesSha256: candidate.artifacts.releases.sha256,
  installedVersion: String(status.version),
  installedOk: true,
  projectCount,
  verifiedAt,
};
writeFileSync(
  join(root, "output", "release-and-install.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  `\n完成：${target} 已安装并在运行，system/status 报 version=${String(status.version)}、ok=${String(status.ok)}、projectCount=${String(status.projectCount)}\n`,
);
