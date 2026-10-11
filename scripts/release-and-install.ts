/**
 * 一条命令走完：升版本号 → 十阶段流水线 → 安装（首次安装 / 3.x 更新 / 从 2.x 升级 / 从
 * Electron 1.x 迁移）→ 对运行实例实测。
 *
 * 3.x 起不再清场：distribution-smoke 的安装验收写真实的卸载项、开始菜单与任务计划程序，只在
 * 声明了 ATM_DISTRIBUTION_CLEAN_MACHINE=1 的干净机器上跑（distribution-installed.ts）；本机
 * 永远跳过它，也就没有理由先卸掉用户的安装。机器上已有的安装原样保留，按它的世代走：
 *   3.x       投递进本地更新源（N\updates），安装根里的 setup --update 装上——和用户点
 *             「立即更新」是同一条路。
 *   2.x       用候选自己的 setup install：停 2.0、切换、3.0 首次启动把 L 转换进 N，失败撤回
 *             （install-drill 的 v2-v3 场景验的就是这条）。
 *   Electron  候选的 setup install --force：迁移事务，可回到 Electron。
 * 这样装出来的候选没有 INSTALLED 层：最后对运行实例的实测只写 output/release-and-install.json，
 * GitHub 发布入口会拒绝这种候选。要签发稳定版，得在干净机器上跑一轮带安装验收的全量发布。
 *
 * 必须在能真实写入 %LOCALAPPDATA% 的终端里跑。Agent 的 Bash 工具对该路径的
 * 创建会落进只有它自己看得见的覆盖层（删除却是穿透的），安装看起来成功、实际
 * 没落盘；PowerShell 工具与真实磁盘一致。详见 ATM-R-067。
 *
 *   pnpm exec tsx scripts/release-and-install.ts --version 3.0.1
 *   pnpm exec tsx scripts/release-and-install.ts            # 不升版，重打当前版本
 *   ... --resume                                             # 仅完整指纹命中时复用（release.ts 判定）
 *   ... --skip-install                                      # 只跑到产出 release/
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { agentFetch } from "./agent-fetch.js";
import { launchDirect, launchThroughShell } from "./launch-installed-app.js";
import { portableZipName } from "./package-native.js";
import { assertReleaseArtifact } from "./release-artifact-evidence.js";
import { deliverUpdate, pruneConsumedFeed, updateFeedDir } from "./update-feed.js";
import {
  commitReleasePreparation,
  computeReleaseFingerprint,
  releaseFingerprintsMatch,
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

/** 主版本 ≥ 3 是 3.x：与 install-state/src/startup.rs `is_v3` 同一规则。 */
function isV3(version: string): boolean {
  const major = Number(version.split(/[.\-+]/u)[0]);
  return Number.isSafeInteger(major) && major >= 3;
}
// 3.x 的升级、转换、保活都按主版本认 3.x：版本号不是 3.x 的候选装上去会被当成 2.x。
if (!isV3(target)) throw new Error(`TARGET_NOT_V3: ${target}（3.x 的发布链只发 3.x）`);

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
const installRoot = join(localAppData, "AyanamiTaskManagerDesktop");
/** 3.0 根 N：运行文件、lifecycle 日志与本地更新源都在这里（安装出来的应用用产品默认的根）。 */
const v3Root = join(localAppData, "AyanamiTaskManager3");

/**
 * 机器上现有的安装：
 *   v3        atm-setup 装的 3.x（安装根 app.json 的 current 主版本 ≥ 3）
 *   v2        atm-setup 装的 2.x
 *   electron  Squirrel 装的 1.x（安装根有 Update.exe）
 *   none      没装过
 */
function existingInstall(): "v3" | "v2" | "electron" | "none" {
  const pointer = join(installRoot, "app.json");
  if (existsSync(pointer)) {
    const current = (JSON.parse(readFileSync(pointer, "utf8")) as { current?: unknown }).current;
    return typeof current === "string" && isV3(current) ? "v3" : "v2";
  }
  return existsSync(join(installRoot, "Update.exe")) ? "electron" : "none";
}
const existing = existingInstall();
if (existing !== "none") step(`机器上已有安装（${existing}）：保留，最后按它的世代装上 ${target}`);

const releaseFingerprint = await computeReleaseFingerprint(root);

step("十阶段流水线");
// 本机安装验收的候选允许不可分发（例如 Node 许可证原文待补）；release.json 照实记下，
// 发布入口（publish-verified-release）只收 distributable 的候选。--resume 是否沿用旧证据由
// release.ts 按完整 fingerprint 判定。
const releaseCommand = flag("resume")
  ? "pnpm exec tsx scripts/release.ts --resume --local-only"
  : "pnpm exec tsx scripts/release.ts --local-only";
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

const feed = updateFeedDir(v3Root);
if (existing === "v3") {
  // 已经装着 3.x：投递进本地更新源，让安装根里的 setup 按更新事务装上（停当前实例、
  // 切换、带窗口启动新版本、失败自动撤回）——和用户点「立即更新」走的是同一条路。
  step("投递到本地更新源（N\\updates）并更新");
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
  step(
    existing === "electron"
      ? `迁移 Electron 1.x → ${target}`
      : existing === "v2"
        ? `从 2.x 升级到 ${target}（3.0 首次启动把 2.x 数据转换进 N）`
        : `首次安装 ${target}`,
  );
  if (existing === "v2") {
    process.stdout.write(
      "  若弹出「选择数据来源」窗口，按窗口里的说明选；无人选择时安装会等到上限后撤回。\n",
    );
  }
  // 迁移要先停掉正在运行的 1.x（它没有退出管道），所以带 --force；数据根保持原样，
  // 旧版本隔离进 state\rollback，开始菜单里的「ATM 修复」可以回到它。
  const install = run(releaseFile("setup"), [
    "install",
    releaseFile("manifest"),
    "--quiet",
    ...(existing === "electron" ? ["--force"] : []),
  ]);
  if (install !== 0) throw new Error(`SETUP_EXIT: ${install}`);
}
const pointer = JSON.parse(readFileSync(join(installRoot, "app.json"), "utf8")) as {
  current?: string;
};
if (pointer.current !== target) throw new Error(`INSTALLED_VERSION_MISMATCH: ${pointer.current}`);
// 投递是一次性的：装好之后连同 Squirrel 时代的 RELEASES / nupkg 一起清掉（宿主下次检查也会清）。
const consumed = pruneConsumedFeed(feed, target);
if (consumed.length > 0) process.stdout.write(`  清理本地更新源 ${consumed.length} 个已消费文件\n`);

step("启动并对运行实例实测");
const installedLauncher = join(installRoot, "AyanamiTaskManager.exe");
const runtimePath = join(v3Root, "runtime", "daemon.json");

async function waitForStatus(seconds: number): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < seconds; i += 1) {
    await sleep(1000);
    if (!existsSync(runtimePath)) continue;
    try {
      const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as {
        endpoint: string;
        token: string;
      };
      // 3.x 的 Agent HTTP 拒绝带 Sec-Fetch-* 的请求，Node 自带的 fetch 会带：走 node:http。
      const response = await agentFetch(`${runtime.endpoint}/api/v1/system/status`, {
        headers: { authorization: `Bearer ${runtime.token}` },
      });
      if (!response.ok) continue;
      return (await response.json()) as Record<string, unknown>;
    } catch {
      // 服务还没起来
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
// Agent 的 MCP shim 收到请求就会自己唤醒桌面——那是从 Agent 宿主里拉起的。生命周期日志记着
// 最近一次启动是不是这样来的。
const lifecycleLog = join(v3Root, "logs", "lifecycle.ndjson");
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
    "  ⚠ 运行实例是被 Agent 的 MCP shim 唤醒的，不是本次安装启动的那个：它可能在 Agent 宿主内，\n" +
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
  schemaVersion: 5,
  candidateSha256: candidate.candidateSha256,
  version: target,
  gitHead: candidate.gitHead,
  installPath:
    existing === "electron"
      ? "migrated-from-electron"
      : existing === "v2"
        ? "upgraded-from-2.x"
        : existing === "v3"
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
