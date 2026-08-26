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
import { join } from "node:path";

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
