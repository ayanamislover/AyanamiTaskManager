/**
 * 一条命令走完：升版本号 → 十阶段流水线 → 安装（首次安装 / 原生版更新 / 从 Electron 1.x
 * 迁移）→ 对运行实例实测。
 *
 * 已是原生版时默认清场（atm-setup --uninstall，数据保留）后全量验收。只有显式 --resume 且
 * 上一轮完整 release fingerprint（含 stageHashes 完整键集和值）逐字段相同时，才允许沿用
 * 已通过的旧证据、不清场，改走本地更新源 + atm-setup --update；局部阶段哈希绝不构成稳定
 * 签发授权。还是 Electron 1.x 时不清场，最后走迁移事务（可回到 Electron）。
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
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launchDirect, launchThroughShell } from "./launch-installed-app.js";
import { portableZipName } from "./package-native.js";
import {
  assertReleaseArtifact,
  assertReleaseResumeEvidence,
  installedSmokeVerified,
  releaseResumeEvidencePaths,
  type ReleaseResumeEvidenceManifest,
} from "./release-artifact-evidence.js";
import {
  assertSafeInstallRoot,
  findProductShortcuts,
  stopInstalledShimsScript,
} from "./product-install-sites.js";
import { deliverUpdate, pruneConsumedFeed, updateFeedDir } from "./update-feed.js";
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
    // 漏改一处版本号，包里自报的版本和清单对不上，装出来的不是想发的那一版。
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

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("LOCALAPPDATA_MISSING");
// 收窄后再固化一次：闭包里 TS 不保留顶层的 narrowing。
const localAppDataRoot: string = localAppData;
const installRoot = join(localAppData, "AyanamiTaskManagerDesktop");
const dataRoot = join(localAppData, "AyanamiTaskManager");

/**
 * 机器上现有的安装：
 *   native    atm-setup 装的（安装根有 app.json）
 *   electron  Squirrel 装的 1.x（安装根有 Update.exe）——第一次装原生版就是迁移
 *   none      没装过
 */
const existing: "native" | "electron" | "none" = existsSync(join(installRoot, "app.json"))
  ? "native"
  : existsSync(join(installRoot, "Update.exe"))
    ? "electron"
    : "none";

function uninstallRegistered(): boolean {
  return (
    spawnSync(
      "reg.exe",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AyanamiTaskManagerDesktop",
      ],
      { windowsHide: true },
    ).status === 0
  );
}

// distribution-smoke 的安装验收要求「没有已安装版本」。稳定签发只有显式 --resume 且完整
// fingerprint 命中已通过报告时才能沿用这份证据；局部 stageHash 相同不构成跳过清场或稳定
// 签发验证的授权。
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
      releaseResumeEvidencePaths(resumeManifest.candidate, previousRun?.commands ?? [], {
        installed: installedSmokeVerified(root),
      }),
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

// 1.x 不清场：卸掉它就没有了「回到 Electron」，第一次装原生版要走真正的迁移事务（快照、
// 隔离旧版、失败自动撤回）。安装验收因此跳过，候选没有 INSTALLED 层：最后对运行实例的
// 实测只写 output/release-and-install.json，不补发布报告，GitHub 发布入口会拒绝这种候选。
// 要签发稳定版，得在干净机器上跑一轮带安装验收的全量发布。
const migrating = existing === "electron";
const needsCleanRoom = existing === "native" && !canReuseDistributionSmoke;
if (migrating) {
  step("检测到 Electron 1.x 安装：保留它，最后走迁移");
  process.env.ATM_DISTRIBUTION_SKIP_INSTALLED = "1";
} else if (existing === "native" && canReuseDistributionSmoke) {
  step("跳过清场");
  process.stdout.write(
    `  完整 fingerprint 命中（${releaseResume.reason}），复用已通过的 distribution-smoke 稳定签发证据。\n` +
      `  不卸载：应用保持运行，新版本经本地更新源由 atm-setup --update 装上。\n`,
  );
}

async function clearInstallation(): Promise<void> {
  step("清场：卸载当前原生版（用户数据保留）");
  assertSafeInstallRoot(installRoot, localAppDataRoot);
  // Agent 会话拉起的 atm-mcp.exe 占着安装根里的 shim；卸载遇到在用的文件会停在半途。
  const stopped = stopInstalledShims();
  if (stopped.length > 0) process.stdout.write(`  结束安装根里的 MCP shim ${stopped.length} 个\n`);
  const uninstall = run(join(installRoot, "atm-setup.exe"), ["--uninstall", "--force", "--quiet"]);
  if (uninstall !== 0) throw new Error(`UNINSTALL_EXIT: ${uninstall}`);
  // 安装根里的 setup 删不掉正在运行的自己：它把卸载交给 %TEMP% 里的副本，自己先返回。
  for (
    let i = 0;
    i < 120 && (existsSync(join(installRoot, "app.json")) || uninstallRegistered());
    i += 1
  )
    await sleep(1000);
  if (existsSync(join(installRoot, "app.json")) || uninstallRegistered())
    throw new Error("UNINSTALL_INCOMPLETE");
  // 快捷方式归 atm-setup 管：它按目标核对归属，只删本安装的。这里只报告剩下的，不按名字删——
  // 同名的可能是便携版或用户自己改指别处的入口。
  const remaining = await findProductShortcuts();
  if (remaining.length > 0) {
    process.stdout.write(
      `  卸载后仍有 ${remaining.length} 个产品名快捷方式（未动，不属于本安装）\n`,
    );
  }
}

function stopInstalledShims(): number[] {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", stopInstalledShimsScript(installRoot)],
    { encoding: "utf8", windowsHide: true },
  );
  return (result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
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
const expectedNames = {
  setup: "atm-setup.exe",
  package: `atm-${target}-win-x64.zip`,
  manifest: `atm-${target}-win-x64.json`,
  portable: portableZipName(target),
} as const;
for (const [key, name] of Object.entries(expectedNames) as Array<
  [keyof typeof expectedNames, string]
>) {
  if (candidate.artifacts[key].name !== name)
    throw new Error(
      `${key.toUpperCase()}_MANIFEST_NAME_MISMATCH: ${candidate.artifacts[key].name}`,
    );
}
const releaseFile = (key: keyof typeof expectedNames) =>
  join(root, "release", candidate.artifacts[key].name);
await Promise.all(
  (Object.keys(expectedNames) as Array<keyof typeof expectedNames>).map((key) =>
    assertReleaseArtifact(releaseFile(key), candidate.artifacts[key]),
  ),
);
if (flag("skip-install")) {
  process.stdout.write(`\n产物就绪：${join(root, "release")}\n（--skip-install，未安装）\n`);
  process.exit(0);
}

const feed = updateFeedDir(dataRoot);
if (existing === "native" && !needsCleanRoom) {
  // 已经装着、也没清场：投递进本地更新源，让安装根里的 setup 按更新事务装上（停当前实例、
  // 切换、带窗口启动新版本、失败自动撤回）——和用户点「立即更新」走的是同一条路。
  step("投递到本地更新源并更新");
  const delivered = deliverUpdate(feed, join(root, "release"), target);
  await assertReleaseArtifact(delivered.zip, candidate.artifacts.package);
  await assertReleaseArtifact(delivered.manifest, candidate.artifacts.manifest);
  const updated = run(join(installRoot, "atm-setup.exe"), [
    "--update",
    delivered.manifest,
    "--quiet",
  ]);
  if (updated !== 0) throw new Error(`UPDATE_EXIT: ${updated}`);
} else {
  step(migrating ? `迁移 Electron 1.x → ${target}` : `首次安装 ${target}`);
  // 迁移要先停掉正在运行的 1.x（它没有退出管道），所以带 --force；数据根保持原样，
  // 旧版本隔离进 state\rollback，开始菜单里的「ATM 修复」可以回到它。
  const install = run(releaseFile("setup"), [
    "install",
    releaseFile("manifest"),
    "--quiet",
    ...(migrating ? ["--force"] : []),
  ]);
  if (install !== 0) throw new Error(`SETUP_EXIT: ${install}`);
}
const pointer = JSON.parse(readFileSync(join(installRoot, "app.json"), "utf8")) as {
  current?: string;
};
if (pointer.current !== target) throw new Error(`INSTALLED_VERSION_MISMATCH: ${pointer.current}`);
// 投递是一次性的：装好之后连同 Squirrel 时代的 RELEASES / nupkg 一起清掉。
const consumed = pruneConsumedFeed(feed, target);
if (consumed.length > 0) process.stdout.write(`  清理本地更新源 ${consumed.length} 个已消费文件\n`);

step("启动并对运行实例实测");
const installedLauncher = join(installRoot, "AyanamiTaskManager.exe");
const runtimePath = join(dataRoot, "runtime", "daemon.json");

async function waitForStatus(seconds: number): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < seconds; i += 1) {
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
      return (await response.json()) as Record<string, unknown>;
    } catch {
      // daemon 还没起来
    }
  }
  return null;
}

// 安装事务已经带着新版本启动；这里经桌面 shell 再点一次入口（单实例转交成 SHOW）。若机器上
// 没有在跑的实例，explorer 拉起的正式版不在 Agent 终端的 Job 里、也不带它的环境变量。
launchThroughShell(installedLauncher);
let status = await waitForStatus(20);
if (!status) {
  // 没有桌面 shell（服务会话、explorer 未运行）时 explorer 起不来任何东西。若 explorer
  // 那边只是慢，两个实例里后到的会被单实例锁挡回去，最坏只是多打一条提示。
  process.stdout.write(
    "  ⚠ explorer 未能拉起 ATM，改为直接启动。该实例在当前 Agent 宿主内、带着它的环境变量，\n" +
      "    关闭宿主会连带结束它：验收后请从托盘完全退出，再从开始菜单启动。\n",
  );
  launchDirect(installedLauncher);
}
status ??= await waitForStatus(45);
if (!status) throw new Error("DAEMON_UNREACHABLE");
// Agent 的 MCP 桥收到请求就会自己唤醒桌面——那是从 Agent 宿主里拉起的。生命周期日志记着
// 最近一次启动是不是这样来的。
const lifecycleLog = join(dataRoot, "logs", "lifecycle-core.ndjson");
const lastStartup = existsSync(lifecycleLog)
  ? readFileSync(lifecycleLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { event?: string; version?: string; agentWake?: boolean };
        } catch {
          return {};
        }
      })
      .findLast((entry) => entry.event === "startup" && entry.version === target)
  : undefined;
if (lastStartup?.agentWake === true) {
  process.stdout.write(
    "  ⚠ 运行实例是被 Agent 的 MCP 桥唤醒的，不是本次安装启动的那个：它可能在 Agent 宿主内，\n" +
      "    关闭宿主会连带结束它。验收后请从托盘完全退出，再从开始菜单启动。\n",
  );
}
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
  schemaVersion: 4,
  candidateSha256: candidate.candidateSha256,
  version: target,
  gitHead: candidate.gitHead,
  installPath: migrating
    ? "migrated-from-electron"
    : existing === "native" && !needsCleanRoom
      ? "updated"
      : "installed",
  setupSha256: candidate.artifacts.setup.sha256,
  packageSha256: candidate.artifacts.package.sha256,
  manifestSha256: candidate.artifacts.manifest.sha256,
  portableSha256: candidate.artifacts.portable.sha256,
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
