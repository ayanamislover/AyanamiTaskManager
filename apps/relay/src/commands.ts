// 命令行：serve / token / app。可在进程内调用（测试用），入口见 cli.ts。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDatabase } from "./database.js";
import { LIMIT_ENV, limitsFromEnv } from "./limits.js";
import { type RelayLogger, streamLogger } from "./log.js";
import { type RunningRelay, type TlsFiles, startRelay } from "./server.js";
import {
  DEFAULT_APP_ID,
  RelayAdminError,
  createApp,
  createToken,
  listApps,
  listTokens,
  revokeToken,
} from "./tokens.js";
import { RELAY_NAME, RELAY_VERSION } from "./version.js";

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  /** serve 用：等到该退出的时候 resolve（默认监听 SIGINT/SIGTERM）。 */
  waitForShutdown?: (relay: RunningRelay, log: RelayLogger) => Promise<void>;
};

export const HELP = `${RELAY_NAME} ${RELAY_VERSION} — AyanamiTaskManager 手机同步的自建中继（只见密文）

用法：
  ${RELAY_NAME} serve --data <目录> [--listen <主机:端口>] [--tls-cert <pem> --tls-key <pem>]
                  [--trust-proxy] [--quiet]
  ${RELAY_NAME} token create --label <名称> [--app <应用>] --data <目录>
  ${RELAY_NAME} token list [--app <应用>] [--json] --data <目录>
  ${RELAY_NAME} token revoke <token-id> --data <目录>
  ${RELAY_NAME} app list [--json] --data <目录>
  ${RELAY_NAME} app create <应用> [--name <名称>] --data <目录>

选项：
  --data <目录>          数据目录（库与 initial-token.txt）；也可用环境变量 ATM_RELAY_DATA
  --listen <主机:端口>   监听地址，默认 127.0.0.1:8790；对局域网或反向代理开放用 0.0.0.0:8790
  --tls-cert/--tls-key  直接提供 HTTPS（PEM 文件）；收到 SIGHUP 时重新读取
  --trust-proxy         位于反向代理之后时打开：X-Forwarded-For 只用作未认证请求的限流键
  --quiet               不打印每个请求的访问日志
  --app <应用>          默认 ${DEFAULT_APP_ID}
  --json                以 JSON 输出列表
  -h, --help            显示本帮助；--version 显示版本

首次 serve 会建立应用 ${DEFAULT_APP_ID} 并签发一枚 token，明文写进 <数据目录>/initial-token.txt。
token 明文只在签发时出现一次，服务端只存 SHA-256。
限额可用环境变量覆盖：${Object.values(LIMIT_ENV).join("、")}。
`;

class UsageError extends Error {}

const OPTIONS = {
  data: { type: "string" },
  listen: { type: "string" },
  "tls-cert": { type: "string" },
  "tls-key": { type: "string" },
  "trust-proxy": { type: "boolean" },
  quiet: { type: "boolean" },
  label: { type: "string" },
  app: { type: "string" },
  name: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];

function dataDir(values: Values, env: NodeJS.ProcessEnv): string {
  const dir = values.data ?? env.ATM_RELAY_DATA;
  if (!dir) throw new UsageError("缺少 --data <目录>（或环境变量 ATM_RELAY_DATA）");
  return resolve(dir);
}

/** `主机:端口`、`[IPv6]:端口`、`:端口`（全部接口）或单独的端口（仅本机）。 */
export function parseListen(raw: string): { host: string; port: number } {
  const v6 = /^\[([^\]]+)\]:(\d{1,5})$/.exec(raw);
  const v4 = /^([^:[\]]*):(\d{1,5})$/.exec(raw);
  let host: string;
  let portText: string;
  if (v6) [host, portText] = [v6[1]!, v6[2]!];
  else if (v4) [host, portText] = [v4[1] || "0.0.0.0", v4[2]!];
  else if (/^\d{1,5}$/.test(raw)) [host, portText] = ["127.0.0.1", raw];
  else
    throw new UsageError(
      `--listen 不合法：${raw}（示例：127.0.0.1:8790、0.0.0.0:8790、[::]:8790）`,
    );
  const port = Number(portText);
  if (port > 65535) throw new UsageError(`--listen 端口超出范围：${raw}`);
  return { host, port };
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => [...(row[column] ?? "")].length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell + " ".repeat(widths[column]! - [...cell].length))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function readTls(values: Values): TlsFiles | undefined {
  const cert = values["tls-cert"];
  const key = values["tls-key"];
  if (!cert && !key) return undefined;
  if (!cert || !key) throw new UsageError("--tls-cert 与 --tls-key 必须同时提供");
  return { cert: readFileSync(resolve(cert)), key: readFileSync(resolve(key)) };
}

function defaultWaitForShutdown(relay: RunningRelay, log: RelayLogger): Promise<void> {
  return new Promise((done) => {
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) {
        log.warn(`再次收到 ${signal}，立即退出`);
        process.exit(1);
      }
      stopping = true;
      log.info(`收到 ${signal}，正在结束长轮询并关闭数据库…`);
      void relay.close().then(done);
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
  });
}

async function serve(values: Values, io: CliIo): Promise<number> {
  const dir = dataDir(values, io.env);
  const { host, port } = parseListen(values.listen ?? "127.0.0.1:8790");
  const tls = readTls(values);
  const limits = limitsFromEnv(io.env);
  const log = streamLogger(io.stderr);
  const relay = await startRelay({
    dataDir: dir,
    host,
    port,
    ...(tls ? { tls } : {}),
    trustProxy: values["trust-proxy"] === true,
    limits,
    log,
    accessLog: values.quiet !== true,
  });
  log.info(`${RELAY_NAME} ${RELAY_VERSION} 已启动：${relay.url}（数据目录 ${dir}）`);
  if (tls && process.platform !== "win32") {
    process.on("SIGHUP", () => {
      try {
        relay.reloadTls(readTls(values)!);
        log.info("已重新加载 TLS 证书");
      } catch (error) {
        log.error(`重新加载 TLS 证书失败：${(error as Error).message}`);
      }
    });
  }
  await (io.waitForShutdown ?? defaultWaitForShutdown)(relay, log);
  log.info("已退出");
  return 0;
}

function tokenCommand(sub: string | undefined, rest: string[], values: Values, io: CliIo): number {
  const db = openDatabase(dataDir(values, io.env));
  try {
    if (sub === "create") {
      if (!values.label) throw new UsageError("token create 需要 --label <名称>");
      const issued = createToken(db, values.app ?? DEFAULT_APP_ID, values.label);
      // 明文单独一行写 stdout，其余说明写 stderr：`TOKEN=$(atm-relay token create …)` 能直接拿到。
      io.stderr(
        `已为应用 ${issued.token.app_id} 签发 token ${issued.token.id}（${issued.token.label}）。明文只显示这一次：\n`,
      );
      io.stdout(`${issued.plaintext}\n`);
      return 0;
    }
    if (sub === "list") {
      const tokens = listTokens(db, values.app);
      if (values.json) {
        io.stdout(`${JSON.stringify(tokens, null, 2)}\n`);
        return 0;
      }
      const rows = [["ID", "应用", "标签", "前缀", "创建时间", "最近使用", "状态"]];
      for (const token of tokens) {
        rows.push([
          token.id,
          token.app_id,
          token.label,
          `${token.prefix}…`,
          token.created_at,
          token.last_used_at ?? "-",
          token.revoked_at ? `已撤销 ${token.revoked_at}` : "有效",
        ]);
      }
      io.stdout(tokens.length === 0 ? "（没有 token）\n" : `${table(rows)}\n`);
      return 0;
    }
    if (sub === "revoke") {
      const id = rest[0];
      if (!id || rest.length > 1) throw new UsageError("用法：token revoke <token-id>");
      const outcome = revokeToken(db, id);
      if (outcome === "missing") throw new RelayAdminError(`没有 ID 为 ${id} 的 token`);
      io.stdout(outcome === "already" ? `${id} 早已撤销\n` : `已撤销 ${id}，立即生效\n`);
      return 0;
    }
    throw new UsageError("token 子命令只有 create、list、revoke");
  } finally {
    db.close();
  }
}

function appCommand(sub: string | undefined, rest: string[], values: Values, io: CliIo): number {
  const db = openDatabase(dataDir(values, io.env));
  try {
    if (sub === "list") {
      const apps = listApps(db);
      if (values.json) {
        io.stdout(`${JSON.stringify(apps, null, 2)}\n`);
        return 0;
      }
      const rows = [["应用", "名称", "文档数", "字节", "有效 token", "创建时间"]];
      for (const app of apps) {
        rows.push([
          app.id,
          app.name,
          String(app.document_count),
          String(app.storage_bytes),
          String(app.active_tokens),
          app.created_at,
        ]);
      }
      io.stdout(apps.length === 0 ? "（没有应用）\n" : `${table(rows)}\n`);
      return 0;
    }
    if (sub === "create") {
      const id = rest[0];
      if (!id || rest.length > 1) throw new UsageError("用法：app create <应用> [--name <名称>]");
      const app = createApp(db, id, values.name ?? id);
      io.stdout(`已建立应用 ${app.id}（${app.name}）\n`);
      return 0;
    }
    throw new UsageError("app 子命令只有 list、create");
  } finally {
    db.close();
  }
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    const [command, sub, ...rest] = positionals;
    if (values.version) {
      io.stdout(`${RELAY_VERSION}\n`);
      return 0;
    }
    if (values.help || command === undefined || command === "help") {
      io.stdout(HELP);
      return 0;
    }
    if (command === "serve") {
      if (sub !== undefined) throw new UsageError(`serve 不接受位置参数：${sub}`);
      return await serve(values, io);
    }
    if (command === "token") return tokenCommand(sub, rest, values, io);
    if (command === "app") return appCommand(sub, rest, values, io);
    throw new UsageError(`未知命令：${command}`);
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (error instanceof UsageError || code.startsWith("ERR_PARSE_ARGS_")) {
      io.stderr(`${(error as Error).message}\n运行 ${RELAY_NAME} --help 查看用法\n`);
      return 2;
    }
    if (error instanceof RelayAdminError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    io.stderr(`${RELAY_NAME} 出错：${(error as Error).message ?? String(error)}\n`);
    return 1;
  }
}
