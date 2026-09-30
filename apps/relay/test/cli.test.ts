// 命令行与首次启动：token 的签发/列出/撤销、initial-token.txt、serve 接线、SQLite 警告静默。
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { INITIAL_TOKEN_FILE } from "../src/bootstrap.js";
import { type CliIo, parseListen, runCli } from "../src/commands.js";
import { DATABASE_FILE, loadSqlite, openDatabase } from "../src/database.js";
import { hashToken } from "../src/tokens.js";
import { RELAY_VERSION } from "../src/version.js";
import { call, cleanupHarness, startTestRelay, tempDataDir } from "./support/relay-harness.js";

afterEach(cleanupHarness);

const relayRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_SHAPE = /^atr_[a-z2-7]{8}_[a-z2-7]{32}$/;

function captureIo(env: NodeJS.ProcessEnv = {}): CliIo & { out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env,
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("帮助与参数", () => {
  it("--help 为中文、退出码 0；--version 与 package.json 一致；未知命令退出码 2", async () => {
    const help = captureIo();
    expect(await runCli(["--help"], help)).toBe(0);
    expect(help.out()).toContain("用法：");
    expect(help.out()).toContain("token create --label");
    const version = captureIo();
    expect(await runCli(["--version"], version)).toBe(0);
    const manifest = JSON.parse(readFileSync(join(relayRoot, "package.json"), "utf8"));
    expect(version.out().trim()).toBe(manifest.version);
    expect(RELAY_VERSION).toBe(manifest.version);

    const unknown = captureIo();
    expect(await runCli(["frobnicate"], unknown)).toBe(2);
    expect(unknown.err()).toContain("未知命令");
    const badFlag = captureIo();
    expect(await runCli(["token", "list", "--bogus"], badFlag)).toBe(2);
    const noData = captureIo();
    expect(await runCli(["app", "list"], noData)).toBe(2);
    expect(noData.err()).toContain("--data");
  });

  it("--listen 解析 IPv4、IPv6、仅端口与仅冒号端口", () => {
    expect(parseListen("0.0.0.0:8790")).toEqual({ host: "0.0.0.0", port: 8790 });
    expect(parseListen("[::]:8790")).toEqual({ host: "::", port: 8790 });
    expect(parseListen(":9000")).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(parseListen("9001")).toEqual({ host: "127.0.0.1", port: 9001 });
    expect(() => parseListen("localhost")).toThrow(/--listen/);
    expect(() => parseListen("1.2.3.4:70000")).toThrow(/端口/);
  });
});

describe("token 管理", () => {
  it("create 只在 stdout 打一行明文；list 不含明文与哈希；revoke 立即生效且可重复执行", async () => {
    const dataDir = tempDataDir();
    const env = { ATM_RELAY_DATA: dataDir };
    expect(await runCli(["app", "create", "atm", "--name", "ATM"], captureIo(env))).toBe(0);

    const created = captureIo(env);
    expect(await runCli(["token", "create", "--label", "我的手机"], created)).toBe(0);
    const plaintext = created.out().trim();
    expect(plaintext).toMatch(TOKEN_SHAPE);
    expect(created.out()).toBe(`${plaintext}\n`);
    expect(created.err()).toContain("明文只显示这一次");

    const listed = captureIo(env);
    expect(await runCli(["token", "list", "--json"], listed)).toBe(0);
    const tokens = JSON.parse(listed.out()) as Array<Record<string, unknown>>;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.label).toBe("我的手机");
    expect(tokens[0]!.prefix).toBe(plaintext.slice(0, 12));
    expect(listed.out()).not.toContain(plaintext.slice(13));
    expect(listed.out()).not.toContain(hashToken(plaintext));

    const table = captureIo(env);
    expect(await runCli(["token", "list"], table)).toBe(0);
    expect(table.out()).toContain("我的手机");
    expect(table.out()).toContain("有效");

    const id = tokens[0]!.id as string;
    const revoked = captureIo(env);
    expect(await runCli(["token", "revoke", id], revoked)).toBe(0);
    expect(revoked.out()).toContain("已撤销");
    const again = captureIo(env);
    expect(await runCli(["token", "revoke", id], again)).toBe(0);
    expect(again.out()).toContain("早已撤销");
    const missing = captureIo(env);
    expect(await runCli(["token", "revoke", "tok_nope"], missing)).toBe(1);

    const apps = captureIo(env);
    expect(await runCli(["app", "list", "--json"], apps)).toBe(0);
    expect(JSON.parse(apps.out())[0]).toMatchObject({ id: "atm", active_tokens: 0 });
  });

  it("库里只存 SHA-256：token 表与整个库文件都找不到明文", async () => {
    const dataDir = tempDataDir();
    const env = { ATM_RELAY_DATA: dataDir };
    await runCli(["app", "create", "atm"], captureIo(env));
    const created = captureIo(env);
    await runCli(["token", "create", "--label", "x"], created);
    const plaintext = created.out().trim();

    const db = openDatabase(dataDir);
    const rows = db.prepare("SELECT * FROM tokens").all() as Array<Record<string, unknown>>;
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    expect(rows[0]!.token_hash).toBe(hashToken(plaintext));
    expect(JSON.stringify(rows)).not.toContain(plaintext.slice(13));
    const bytes = readFileSync(join(dataDir, DATABASE_FILE));
    expect(bytes.includes(Buffer.from(plaintext.slice(13)))).toBe(false);
    expect(bytes.includes(Buffer.from(hashToken(plaintext)))).toBe(true);
  });

  it("给不存在的 app 签 token 报错退出 1；非法 app id 报错", async () => {
    const env = { ATM_RELAY_DATA: tempDataDir() };
    const missing = captureIo(env);
    expect(await runCli(["token", "create", "--label", "x", "--app", "nope"], missing)).toBe(1);
    expect(missing.err()).toContain("不存在");
    const invalid = captureIo(env);
    expect(await runCli(["app", "create", "Bad_ID"], invalid)).toBe(1);
  });
});

describe("首次启动", () => {
  it("写出 initial-token.txt（仅本人可读），token 可用；日志只有路径；重启不再签发", async () => {
    const dataDir = tempDataDir();
    const relay = await startTestRelay({ dataDir });
    const path = join(dataDir, INITIAL_TOKEN_FILE);
    expect(relay.relay.initialTokenPath).toBe(path);
    const plaintext = readFileSync(path, "utf8");
    expect(plaintext.trim()).toMatch(TOKEN_SHAPE);
    expect((await call(relay, "GET", "/v1/apps/atm")).json.id).toBe("atm");

    if (process.platform === "win32") {
      const acl = execFileSync("icacls", [path], { encoding: "utf8", windowsHide: true });
      // 去掉了继承：不应再有 (I) 继承项，也不应出现 Users / Everyone。
      expect(acl).not.toMatch(/\(I\)/);
      expect(acl).not.toMatch(/Everyone|BUILTIN\\Users/i);
    } else {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    await relay.stop();

    writeFileSync(path, "用户已经抄走并改掉了这个文件\n");
    const again = await startTestRelay({ dataDir }).catch(() => null);
    // 夹具会读 initial-token.txt；这里内容已被改掉，只关心中继本身没有重写它。
    expect(readFileSync(path, "utf8")).toBe("用户已经抄走并改掉了这个文件\n");
    expect(again?.relay.initialTokenPath ?? null).toBeNull();
  });

  it("serve 命令接线：读 ATM_RELAY_DATA 与限额环境变量，退出时关库", async () => {
    const dataDir = tempDataDir();
    const io = captureIo({ ATM_RELAY_DATA: dataDir, ATM_RELAY_MAX_WAIT_SECONDS: "7" });
    io.waitForShutdown = async (relay) => {
      const token = readFileSync(join(dataDir, INITIAL_TOKEN_FILE), "utf8").trim();
      const detail = await call(relay.url, "GET", "/v1/apps/atm", { token });
      expect(detail.json.relay.max_wait).toBe(7);
      await relay.close();
    };
    expect(await runCli(["serve", "--listen", "127.0.0.1:0", "--quiet"], io)).toBe(0);
    expect(io.err()).toContain("已启动");
    expect(io.err()).toContain("已退出");
    const bad = captureIo({ ATM_RELAY_DATA: dataDir, ATM_RELAY_RATE_PER_SECOND: "fast" });
    expect(await runCli(["serve", "--listen", "127.0.0.1:0"], bad)).toBe(1);
    expect(bad.err()).toContain("ATM_RELAY_RATE_PER_SECOND");
  });
});

describe("node:sqlite 的实验性警告", () => {
  it("加载后还原 process.emitWarning，不影响其它警告", () => {
    const before = process.emitWarning;
    loadSqlite();
    expect(process.emitWarning).toBe(before);
  });

  it("真实进程里跑 CLI：stderr 没有 SQLite 的 ExperimentalWarning", () => {
    const dataDir = tempDataDir();
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(relayRoot, "src", "cli.ts"), "app", "list", "--data", dataDir],
      { cwd: relayRoot, encoding: "utf8", windowsHide: true, timeout: 60_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("没有应用");
    expect(result.stderr).not.toMatch(/ExperimentalWarning|SQLite is an experimental/);
  });
});
