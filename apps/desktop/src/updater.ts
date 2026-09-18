import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export type UpdatePhase = "CHECK" | "DOWNLOAD" | "VERIFY" | "INSTALL" | "READY";
export type UpdateOutcome = "IN_PROGRESS" | "SUCCESS" | "ERROR" | "SKIPPED";

export type UpdateStatus = {
  phase: UpdatePhase;
  outcome: UpdateOutcome;
  code: string;
  message: string;
  action: string;
  at: string;
  version: string | null;
};

type UpdateRecord = {
  phase: UpdatePhase;
  outcome: UpdateOutcome;
  code: string;
  detail?: unknown;
  version?: string | null;
};

type UpdateDiagnosticsOptions = {
  maxLogBytes?: number;
  maxLogFiles?: number;
  now?: () => Date;
};

const DEFAULT_LOG_BYTES = 256 * 1024;
const DEFAULT_LOG_FILES = 3;
const MAX_DETAIL_LENGTH = 512;

const updateActions: Record<string, string> = {
  CHECK_FAILED: "请检查本地更新目录中的 RELEASES 与安装包是否完整。",
  DOWNLOAD_FAILED: "请确认更新包仍在本地更新目录中，并稍后重试。",
  VERIFY_FAILED: "更新包校验失败，请重新生成并投递完整安装包。",
  INSTALL_FAILED: "更新安装未完成；当前版本仍可使用，请重新运行安装包。",
  UPDATE_FAILED: "当前版本仍可使用；请打开更新日志排查后重试。",
  UPDATE_SOURCE_MISSING: "当前没有待安装的本地更新，无需处理。",
  UPDATE_SOURCE_CONSUMED: "本地更新已经装好，旧安装包已清理。",
  UPDATE_RUNNER_MISSING: "找不到 Squirrel 的 Update.exe，请重新运行安装包。",
  CHECKING: "正在检查本地更新。",
  UPDATE_AVAILABLE: "已发现新版本，正在下载并校验。",
  UP_TO_DATE: "当前已是最新版本。",
  UPDATE_READY: "更新已就绪，下次启动时生效。",
};

function bounded(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_DETAIL_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

export function sanitizeUpdateDetail(detail: unknown): string {
  const source =
    detail instanceof Error
      ? detail.message
      : typeof detail === "string"
        ? detail
        : detail === null || detail === undefined
          ? ""
          : String(detail);
  return bounded(
    source
      .replace(/authorization\s*:\s*(?:bearer\s+)?[^\s,;]+/giu, "Authorization: <redacted>")
      .replace(/\bbearer\s+[^\s,;]+/giu, "Bearer <redacted>")
      .replace(
        /([?&](?:access[_-]?token|token|api[_-]?key|key|signature|auth)=)[^&\s]+/giu,
        "$1<redacted>",
      )
      .replace(
        /\b(?:access[_-]?token|token|api[_-]?key|signature)\s*[=:]\s*[^\s,;]+/giu,
        (match) => {
          const separator = match.includes("=") ? "=" : ":";
          return `${match.slice(0, match.indexOf(separator)).trim()}${separator}<redacted>`;
        },
      )
      .replace(/(?:file:\/\/\/)?[A-Za-z]:\\[^\s"']+/gu, "<local-path>")
      .replace(/\\\\[^\s"']+/gu, "<local-path>"),
  );
}

export function classifyUpdateFailure(
  detail: unknown,
  currentPhase: UpdatePhase,
): Pick<UpdateRecord, "phase" | "code"> {
  const message = sanitizeUpdateDetail(detail).toLowerCase();
  if (/checksum|hash|signature|verify|validation|integrity/u.test(message)) {
    return { phase: "VERIFY", code: "VERIFY_FAILED" };
  }
  if (/install|apply|squirrel|update\.exe/u.test(message)) {
    return { phase: "INSTALL", code: "INSTALL_FAILED" };
  }
  if (currentPhase === "CHECK") return { phase: "CHECK", code: "CHECK_FAILED" };
  if (currentPhase === "INSTALL") return { phase: "INSTALL", code: "INSTALL_FAILED" };
  if (currentPhase === "VERIFY") return { phase: "VERIFY", code: "VERIFY_FAILED" };
  return { phase: "DOWNLOAD", code: "DOWNLOAD_FAILED" };
}

function actionFor(code: string): string {
  return updateActions[code] ?? "当前版本仍可使用；请打开更新日志排查后重试。";
}

export function createUpdateDiagnostics(dataDir: string, options: UpdateDiagnosticsOptions = {}) {
  const logsDir = join(dataDir, "logs");
  const statusPath = join(logsDir, "update-status.json");
  const logPath = join(logsDir, "updater.ndjson");
  const maxLogBytes = Math.max(256, options.maxLogBytes ?? DEFAULT_LOG_BYTES);
  const maxLogFiles = Math.max(1, options.maxLogFiles ?? DEFAULT_LOG_FILES);
  const now = options.now ?? (() => new Date());

  function rotateFor(bytes: number): void {
    if (!existsSync(logPath) || statSync(logPath).size + bytes <= maxLogBytes) return;
    for (let index = maxLogFiles - 1; index >= 1; index -= 1) {
      const destination = join(logsDir, `updater.${index}.ndjson`);
      const source = index === 1 ? logPath : join(logsDir, `updater.${index - 1}.ndjson`);
      rmSync(destination, { force: true });
      if (existsSync(source)) renameSync(source, destination);
    }
  }

  function record(input: UpdateRecord): UpdateStatus {
    const message = sanitizeUpdateDetail(input.detail) || input.code;
    const status: UpdateStatus = {
      phase: input.phase,
      outcome: input.outcome,
      code: input.code,
      message,
      action: actionFor(input.code),
      at: now().toISOString(),
      version: input.version ?? null,
    };
    try {
      mkdirSync(logsDir, { recursive: true });
      const line = `${JSON.stringify(status)}\n`;
      rotateFor(Buffer.byteLength(line));
      appendFileSync(logPath, line, { encoding: "utf8", mode: 0o600 });
      writeFileSync(statusPath, JSON.stringify(status), { encoding: "utf8", mode: 0o600 });
    } catch {
      // 更新诊断永远不能阻断应用本身。内存中的返回值仍可供当前调用者展示。
    }
    return status;
  }

  function read(): UpdateStatus | null {
    try {
      if (!existsSync(statusPath)) return null;
      const value = JSON.parse(readFileSync(statusPath, "utf8")) as UpdateStatus;
      if (!value || typeof value !== "object" || typeof value.code !== "string") return null;
      return value;
    } catch {
      return null;
    }
  }

  return { read, record };
}

/**
 * 更新源是一个本地目录，不是服务器。单机单用户场景下这样最省事：发布链把
 * Squirrel 产出的 RELEASES 和 -full.nupkg 投递进来，运行中的应用自己发现并应用。
 *
 * 本地 feed 也让 delta 包变得没必要——169 MB 在本机是一次文件复制而不是一次
 * 网络下载。delta 是为跨机分发省流量的，真要分发给别人时再说。
 */
export function updateFeedDir(dataDir: string): string {
  return join(dataDir, "updates");
}

/**
 * 没有 RELEASES 就等于没有更新源。这时必须安静地什么都不做：把 autoUpdater
 * 指向一个不存在的源会抛错，而「还没发过任何更新」是完全正常的状态，不该在
 * 用户面前变成一条报错。
 */
export function updateFeedReady(dataDir: string): boolean {
  return existsSync(join(updateFeedDir(dataDir), "RELEASES"));
}

/** RELEASES 的每一行是 `<SHA1> <包名> <字节数>`；包名里带版本号。 */
export function releaseFeedEntries(releases: string): Array<{ name: string; version: string }> {
  return releases
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u)[1])
    .filter((name): name is string => Boolean(name))
    .map((name) => ({ name, version: /-(\d+(?:\.\d+)*)-full\.nupkg$/iu.exec(name)?.[1] ?? "" }));
}

/** 逐段比数字：1.1.0 比 1.0.27 新。段数不同时缺的段按 0 算。 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 清掉已经装完的本地更新。
 *
 * feed 是发布脚本写进来的一次性投递，装完没人负责收。实测本机 RELEASES 还停在
 * 1.0.27、应用早已是 1.1.0，那 164 MB 的包既装不上也删不掉。判据只有一条：
 * RELEASES 里列出的版本全都不高于当前版本，才算「已经消费完」。
 */
export function pruneConsumedUpdateFeed(dataDir: string, currentVersion: string): string[] {
  const feed = updateFeedDir(dataDir);
  const releasesPath = join(feed, "RELEASES");
  if (!existsSync(releasesPath)) return [];
  let entries: Array<{ name: string; version: string }>;
  try {
    entries = releaseFeedEntries(readFileSync(releasesPath, "utf8"));
  } catch {
    return [];
  }
  if (!entries.length) return [];
  // 版本号解析不出来时按「可能更新」处理，宁可留着。
  if (entries.some((entry) => !entry.version || compareVersions(entry.version, currentVersion) > 0))
    return [];
  // 包名来自磁盘上的 RELEASES，异常或被改过的 feed 里它可以是 `../x-1.0.0-full.nupkg`。
  // 先整份校验：只要有一项落在更新目录外，整份 feed 都不处理，绝不先删一半再发现越界。
  const targets = entries.map((entry) => ({
    name: entry.name,
    path: feedFilePath(feed, entry.name),
  }));
  if (targets.some((target) => !target.path)) return [];
  const removed: string[] = [];
  for (const target of targets) {
    if (!existsSync(target.path!)) continue;
    try {
      rmSync(target.path!, { force: true });
      removed.push(target.name);
    } catch {
      // 删不掉就留着：清理失败不该变成一次更新失败。
    }
  }
  try {
    rmSync(releasesPath, { force: true });
    removed.push("RELEASES");
  } catch {
    // 同上。
  }
  return removed;
}

/** 合法包名只能是更新目录里的单层文件名：没有分隔符、没有上级、也不是绝对路径。 */
const FEED_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.nupkg$/u;

/** 包名对应的绝对路径；名字不合法或解析后跑到更新目录外时返回 null。 */
export function feedFilePath(feed: string, name: string): string | null {
  if (!FEED_FILE_NAME.test(name) || name === "." || name === "..") return null;
  const root = resolve(feed);
  const target = resolve(root, name);
  return dirname(target) === root ? target : null;
}

/**
 * Electron 的 autoUpdater 只认 `execPath` 上两级的 Update.exe，而本应用是通过数据根下
 * 的 `current` 目录链接启动的（MCP 配置需要一个不带版本号的固定路径），于是它去
 * 数据目录里找 Update.exe，永远找不到——日志里每 6 小时一条「Can not find Squirrel」。
 */
export function electronUpdateExe(execPath: string): string {
  return join(dirname(dirname(execPath)), "Update.exe");
}

/**
 * 穿透链接之后的真实安装根里的 Update.exe。找得到就能自己驱动 Squirrel，
 * 不必依赖 autoUpdater 那条按 execPath 推出来的路径。
 */
export function resolveUpdateExe(
  execPath: string,
  realpath: (path: string) => string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  for (const candidate of [execPath, safeRealpath(execPath, realpath)]) {
    if (!candidate) continue;
    const updateExe = electronUpdateExe(candidate);
    if (exists(updateExe)) return updateExe;
  }
  return null;
}

function safeRealpath(path: string, realpath: (path: string) => string): string | null {
  try {
    return realpath(path);
  } catch {
    return null;
  }
}

/** `Update.exe --checkForUpdate=<feed>` 最后一行是 JSON。 */
export function parseSquirrelCheck(
  output: string,
): { currentVersion: string; futureVersion: string; releasesToApply: unknown[] } | null {
  const line = output
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.startsWith("{") && value.endsWith("}"))
    .at(-1);
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (!Array.isArray(parsed.releasesToApply)) return null;
    return {
      currentVersion: String(parsed.currentVersion ?? ""),
      futureVersion: String(parsed.futureVersion ?? ""),
      releasesToApply: parsed.releasesToApply,
    };
  } catch {
    return null;
  }
}

export type UpdateCheckPlan =
  | {
      kind: "SKIP";
      code: "UPDATE_SOURCE_MISSING" | "UPDATE_SOURCE_CONSUMED" | "UPDATE_RUNNER_MISSING";
      detail: string;
    }
  | { kind: "ELECTRON" }
  | { kind: "SQUIRREL"; updateExe: string };

/**
 * 一次更新检查该走哪条路。
 *
 * 优先仍然是 Electron 的 autoUpdater——常规安装下它就在 execPath 上两级，行为不变。
 * 只有当那个位置没有 Update.exe（本机就是这样：应用通过 current 链接启动）才自己
 * 驱动穿透链接后的 Update.exe；两个都没有时安静跳过，而不是每 6 小时报一次
 * 「Can not find Squirrel」——那条报错既不是安装失败，用户也无从处理。
 */
export function planUpdateCheck(input: {
  feedReady: boolean;
  consumed: string[];
  electronRunnerReady: boolean;
  resolvedUpdateExe: string | null;
}): UpdateCheckPlan {
  if (input.consumed.length > 0) {
    return {
      kind: "SKIP",
      code: "UPDATE_SOURCE_CONSUMED",
      detail: `本地更新已安装完毕，已清理 ${input.consumed.length} 个文件`,
    };
  }
  if (!input.feedReady) {
    return { kind: "SKIP", code: "UPDATE_SOURCE_MISSING", detail: "当前没有待安装的本地更新" };
  }
  if (input.electronRunnerReady) return { kind: "ELECTRON" };
  if (input.resolvedUpdateExe) return { kind: "SQUIRREL", updateExe: input.resolvedUpdateExe };
  return {
    kind: "SKIP",
    code: "UPDATE_RUNNER_MISSING",
    detail: "安装目录里找不到 Update.exe，本地更新无法应用",
  };
}
