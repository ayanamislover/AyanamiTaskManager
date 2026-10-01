import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  compareVersions,
  createUpdateDiagnostics,
  updateFeedDir,
  type UpdateStatus,
} from "./updater.js";

/**
 * 本地更新（de-electron §8 更新协调，替代 Squirrel 的 UpdateHost）。
 *
 * 更新源仍是数据根下的 `updates\`，投递物换成原生包：发布链先写完整的
 * `atm-<v>-win-x64.zip`，最后写清单 `atm-<v>-win-x64.json`——清单在，包才算投递完。
 * core 只负责「发现、告知、按用户意愿发起」；校验、切换、回滚全是安装根里 atm-setup 的事务，
 * 由宿主拉起（update.rs 说明了为什么不能由 core 自己 spawn）。
 *
 * 和 Squirrel 时代的差别：那时下载后「下次启动生效」，现在安装事务本身会停掉当前实例并带窗口
 * 启动新版本，所以只在用户点「立即更新」时发起，绝不在定时检查里自己动手。
 */

const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?`;
const MANIFEST_NAME = new RegExp(`^atm-(${VERSION})-win-x64\\.json$`, "u");
const PACKAGE_NAME = new RegExp(`^atm-(${VERSION})-win-x64\\.zip$`, "u");
/** Squirrel 时代投递的 RELEASES 与 nupkg：原生安装用不了，留着只占空间（实测 165 MB）。 */
const SQUIRREL_FEED_NAME = /^(?:RELEASES|[A-Za-z0-9][A-Za-z0-9._+-]*\.nupkg)$/u;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 新版本在 START 阶段就已经跑起来了，事务要等见证核对完才写终态。 */
const SETTLE_RECHECK_MS = 10_000;

export type FeedCandidate = {
  version: string;
  manifest: string;
  packageBytes: number;
};

export type FeedScan = {
  /** 比当前版本新、清单与包都完整的最高版本。 */
  candidate: FeedCandidate | null;
  /** 最高的新版本清单不完整或与包对不上：投递坏了，不能装。 */
  invalid: { version: string; reason: string } | null;
  /** 不高于当前版本的原生包与清单，以及 Squirrel 遗留物：可以清掉的文件名。 */
  consumed: string[];
};

function readManifest(path: string, version: string): FeedCandidate | string {
  let manifest: Record<string, unknown>;
  try {
    if (statSync(path).size > MAX_MANIFEST_BYTES) return "MANIFEST_TOO_LARGE";
    manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return "MANIFEST_UNREADABLE";
  }
  const packageName = `atm-${version}-win-x64.zip`;
  if (
    manifest.format !== 1 ||
    manifest.version !== version ||
    manifest.arch !== "x64" ||
    manifest.package !== packageName ||
    typeof manifest.packageBytes !== "number" ||
    typeof manifest.packageSha256 !== "string"
  )
    return "MANIFEST_INVALID";
  const packagePath = join(dirname(path), packageName);
  let size: number;
  try {
    size = statSync(packagePath).size;
  } catch {
    return "PACKAGE_MISSING";
  }
  // 逐字节哈希留给 setup 的 STAGE（它反正要做）；这里只拦「包没写完/写错」这种明显的坏投递。
  if (size !== manifest.packageBytes) return "PACKAGE_SIZE_MISMATCH";
  return { version, manifest: path, packageBytes: size };
}

/** 读一遍更新目录。只看单层文件名，名字不合模式的一律不碰。 */
export function scanUpdateFeed(feed: string, currentVersion: string): FeedScan {
  let names: string[];
  try {
    names = readdirSync(feed, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return { candidate: null, invalid: null, consumed: [] };
  }
  const consumed: string[] = [];
  const newer: string[] = [];
  for (const name of names) {
    if (SQUIRREL_FEED_NAME.test(name)) {
      consumed.push(name);
      continue;
    }
    const version = (MANIFEST_NAME.exec(name) ?? PACKAGE_NAME.exec(name))?.[1];
    if (!version) continue;
    if (compareVersions(version, currentVersion) <= 0) consumed.push(name);
    else if (MANIFEST_NAME.test(name)) newer.push(version);
  }
  newer.sort(compareVersions);
  const highest = newer.at(-1);
  if (!highest) return { candidate: null, invalid: null, consumed };
  const result = readManifest(join(feed, `atm-${highest}-win-x64.json`), highest);
  return typeof result === "string"
    ? { candidate: null, invalid: { version: highest, reason: result }, consumed }
    : { candidate: result, invalid: null, consumed };
}

/** 删掉已消费的文件。名字来自 readdir 且已按模式过滤；删不掉就留着，清理失败不算更新失败。 */
export function pruneUpdateFeed(feed: string, names: string[]): string[] {
  const removed: string[] = [];
  for (const name of names) {
    if (basename(name) !== name) continue;
    try {
      rmSync(join(feed, name), { force: true });
      removed.push(name);
    } catch {
      // 同上。
    }
  }
  return removed;
}

type InstallJournal = { id?: unknown; to?: unknown; outcome?: unknown };

export type UpdateCoordinatorOptions = {
  dataDir: string;
  currentVersion: string;
  /** 安装根（含 app.json 的那一层）；便携版与源码运行为 null，不参与更新。 */
  installRoot: string | null;
  /** 让宿主拉起 `<安装根>\atm-setup.exe --update <manifest>`。 */
  requestInstall(manifest: string): void;
  onUpdateReady(version: string): void;
  now?: () => Date;
};

export class UpdateCoordinator {
  private checking: Promise<UpdateStatus | null> | null = null;
  private ready: FeedCandidate | null = null;
  private timer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  private readonly diagnostics;

  constructor(private readonly options: UpdateCoordinatorOptions) {
    this.diagnostics = createUpdateDiagnostics(
      options.dataDir,
      options.now ? { now: options.now } : {},
    );
  }

  get pendingUpdate(): string | null {
    return this.ready?.version ?? null;
  }

  status(): UpdateStatus | null {
    return this.diagnostics.read();
  }

  /** 定时器与用户手点可能撞在一起：同一时刻只跑一次。 */
  check(): Promise<UpdateStatus | null> {
    if (this.checking) return this.checking;
    const pending = Promise.resolve()
      .then(() => this.runCheck())
      .finally(() => {
        if (this.checking === pending) this.checking = null;
      });
    this.checking = pending;
    return pending;
  }

  private runCheck(): UpdateStatus | null {
    if (this.options.installRoot === null) {
      this.ready = null;
      return this.diagnostics.record({
        phase: "CHECK",
        outcome: "SKIPPED",
        code: "UPDATE_UNSUPPORTED",
        detail: "便携版与源码运行不参与自动更新",
      });
    }
    const previous = this.reportLastInstall();
    if (previous === "PENDING") {
      // 结果未定：不报、不清。这时清掉包，万一事务随后回滚，用户就没有包可以重试了。
      this.settleTimer ??= setTimeout(() => {
        this.settleTimer = null;
        void this.check();
      }, SETTLE_RECHECK_MS);
      this.settleTimer.unref();
      return this.diagnostics.read();
    }
    const feed = updateFeedDir(this.options.dataDir);
    const scan = scanUpdateFeed(feed, this.options.currentVersion);
    const removed = pruneUpdateFeed(feed, scan.consumed);
    if (scan.invalid) {
      this.ready = null;
      return this.diagnostics.record({
        phase: "VERIFY",
        outcome: "ERROR",
        code: "VERIFY_FAILED",
        detail: `${scan.invalid.version} 的安装包不完整（${scan.invalid.reason}）`,
        version: scan.invalid.version,
      });
    }
    if (scan.candidate) {
      const announced = this.ready?.version === scan.candidate.version;
      this.ready = scan.candidate;
      const status = this.diagnostics.record({
        phase: "READY",
        outcome: "SUCCESS",
        code: "UPDATE_READY",
        detail: `${scan.candidate.version} 已就绪，点击「立即更新」重启生效`,
        version: scan.candidate.version,
      });
      if (!announced) this.options.onUpdateReady(scan.candidate.version);
      return status;
    }
    this.ready = null;
    // 刚装完的那次检查：保留「已更新到 x」，不要立刻被「没有更新」盖掉。
    if (previous) return previous;
    if (removed.length > 0)
      return this.diagnostics.record({
        phase: "CHECK",
        outcome: "SKIPPED",
        code: "UPDATE_SOURCE_CONSUMED",
        detail: `本地更新已安装完毕，已清理 ${removed.length} 个文件`,
      });
    return this.diagnostics.record({
      phase: "CHECK",
      outcome: "SKIPPED",
      code: "UPDATE_SOURCE_MISSING",
      detail: "当前没有待安装的本地更新",
    });
  }

  /**
   * 上一次是我们发起的安装（状态停在 INSTALLING），结果在安装根的事务日志里：
   * 成功则本进程就是新版本；没成则 setup 已把旧版本拉回来，这里把原因记下。
   */
  private reportLastInstall(): UpdateStatus | null | "PENDING" {
    const last = this.diagnostics.read();
    if (last?.code !== "INSTALLING" || this.options.installRoot === null) return null;
    let journal: InstallJournal | null = null;
    try {
      journal = JSON.parse(
        readFileSync(join(this.options.installRoot, "state", "install.json"), "utf8"),
      ) as InstallJournal;
    } catch {
      journal = null;
    }
    const target = last.version;
    if (journal && typeof journal.outcome !== "string") return "PENDING";
    if (journal?.outcome === "COMMITTED" && journal.to === this.options.currentVersion)
      return this.diagnostics.record({
        phase: "READY",
        outcome: "SUCCESS",
        code: "UPDATE_INSTALLED",
        detail: `已更新到 ${this.options.currentVersion}`,
        version: this.options.currentVersion,
      });
    if (journal?.to === target && typeof journal.outcome === "string")
      return this.diagnostics.record({
        phase: "INSTALL",
        outcome: "ERROR",
        code: "INSTALL_FAILED",
        detail: `${target} 没有装上（${journal.outcome}），当前仍是 ${this.options.currentVersion}`,
        version: target,
      });
    return null;
  }

  /** 用户点了「立即更新」：先重新确认包还在且完整，再请宿主拉起 setup。 */
  async apply(): Promise<UpdateStatus | null> {
    await this.check();
    const candidate = this.ready;
    if (!candidate) return this.diagnostics.read();
    const status = this.diagnostics.record({
      phase: "INSTALL",
      outcome: "IN_PROGRESS",
      code: "INSTALLING",
      detail: `正在安装 ${candidate.version}，完成后会自动重新打开`,
      version: candidate.version,
    });
    this.options.requestInstall(candidate.manifest);
    return status;
  }

  /** 宿主拒绝或没能拉起 setup。 */
  launchFailed(): void {
    this.diagnostics.record({
      phase: "INSTALL",
      outcome: "ERROR",
      code: "INSTALL_FAILED",
      detail: "安装程序没有启动",
      version: this.ready?.version ?? null,
    });
  }

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.timer = null;
    this.settleTimer = null;
  }
}

/** 安装布局：`<root>\app.json` 与 `<root>\app-<v>\`（core 的 appDir）。 */
export function installRootOf(appDir: string, packaged: boolean): string | null {
  if (!packaged || !/^app-\d/u.test(basename(appDir))) return null;
  const root = dirname(appDir);
  return existsSync(join(root, "app.json")) ? root : null;
}
