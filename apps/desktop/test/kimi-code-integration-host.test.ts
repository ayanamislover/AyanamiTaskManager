import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 走真实的 installAgentIntegrationHost：启动时的过期修复、设置页的「修复」按钮、报告里的
// 「已安装」，三处都要对 Kimi 的 transport 有同一个判断。只测 agent-config 的纯函数，
// 抓不到「函数对了、主进程没接上」这一类问题。HOME 与各 AppData 全部隔离在临时目录里。

const state = vi.hoisted(() => ({
  home: "",
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(name, fn),
  },
  clipboard: { writeText: () => {} },
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => state.home,
}));
// 找得到本机真实的 claude CLI 就会去改真实的 ~/.claude.json，这里一律当作没装。
vi.mock("@ayanami-task/agent-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ayanami-task/agent-config")>()),
  findClaudeCodeCli: () => null,
}));

const { installAgentIntegrationHost } = await import("../src/main-agent-integrations.js");

type KimiReport = { client: string; mcpInstalled: boolean; cliAvailable: boolean };

const root = mkdtempSync(join(tmpdir(), "atm-kimi-host-"));
const savedEnv = { ...process.env };
let configPath = "";
let dataDir = "";

afterEach(() => {
  process.env = { ...savedEnv };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  const caseRoot = mkdtempSync(join(root, "case-"));
  state.home = join(caseRoot, "home");
  dataDir = join(caseRoot, "data");
  configPath = join(state.home, ".kimi-code", "mcp.json");
  mkdirSync(state.home, { recursive: true });
  Object.assign(process.env, {
    USERPROFILE: state.home,
    HOME: state.home,
    APPDATA: join(caseRoot, "Roaming"),
    LOCALAPPDATA: join(caseRoot, "Local"),
    ATM_DATA_DIR: dataDir,
    ATM_PACKAGED_SMOKE: "1",
    ATM_SMOKE_MCP_CONFIG_REPAIR: "1",
    ATM_SMOKE_AGENT_CONFIG_ROOT: caseRoot,
  });
  for (const name of ["atm-plan", "atm-task", "atm-knowledge", "_shared"])
    put(
      join(dataDir, "skills", name, "SKILL.md"),
      `---\natm-integration-version: 1\n---\nskill ${name}\n`,
    );
});

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
const read = () => JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
const backups = () =>
  existsSync(dirname(configPath))
    ? readdirSync(dirname(configPath)).filter((name) => name.startsWith("mcp.json.bak-"))
    : [];
const call = (name: string, ...args: unknown[]) =>
  state.handlers.get(`atm:${name}`)!(null, ...args);
const kimiReport = () =>
  (call("get-agent-integrations") as KimiReport[]).find((each) => each.client === "KIMI_CODE")!;

/** 等同一次应用启动：注册 IPC，并跑启动时的过期修复。 */
function boot(): void {
  state.handlers.clear();
  installAgentIntegrationHost({
    service: {
      getSetting: () => ({ value: true, version: 0 }),
      setSetting: () => {},
    } as never,
    runtime: {} as never,
    dataDir,
    execPath: join(root, "app", "ATM.exe"),
    packaged: true,
    smokeTrace: () => {},
  });
}

function setManagedTransport(transport: string | undefined): void {
  const config = read();
  for (const [name, server] of Object.entries(config.mcpServers as Record<string, any>)) {
    if (!name.startsWith("ayanami-task-manager")) continue;
    if (transport === undefined) delete server.transport;
    else server.transport = transport;
  }
  put(configPath, JSON.stringify(config));
}

const managedTransports = () =>
  Object.entries(read().mcpServers as Record<string, any>)
    .filter(([name]) => name.startsWith("ayanami-task-manager"))
    .map(([, server]) => server.transport);

describe("Kimi Code 接入（主进程）", () => {
  it("没装过的用户：启动不建目录不写文件，报告为未检测到", () => {
    boot();
    expect(existsSync(join(state.home, ".kimi-code"))).toBe(false);
    expect(kimiReport()).toMatchObject({ mcpInstalled: false, cliAvailable: false });

    // 只有别的服务：启动时也一个字节不动，且别的服务的值不进报告。
    const bytes = JSON.stringify({
      mcpServers: { other: { transport: "stdio", command: "other", env: { K: "marker-x" } } },
    });
    put(configPath, bytes);
    boot();
    expect(readFileSync(configPath, "utf8")).toBe(bytes);
    expect(kimiReport()).toMatchObject({ mcpInstalled: false, cliAvailable: true });
    expect(JSON.stringify(call("get-agent-integrations"))).not.toContain("marker-x");
  });

  it.each([
    ["写错成 http", "http"],
    ["缺了 transport", undefined],
  ])("ATM 条目 %s：报告为未装好，启动时自动改回 stdio", (_label, transport) => {
    boot();
    call("manage-agent-integration", "KIMI_CODE", "INSTALL");
    setManagedTransport(transport);
    expect(kimiReport().mcpInstalled).toBe(false);

    boot();
    expect(managedTransports()).toEqual(["stdio", "stdio", "stdio"]);
    expect(kimiReport().mcpInstalled).toBe(true);
  });

  it("「修复」按钮同样会改回 stdio，别的服务原样保留", () => {
    put(configPath, JSON.stringify({ mcpServers: { other: { transport: "http", url: "u" } } }));
    boot();
    call("manage-agent-integration", "KIMI_CODE", "INSTALL");
    setManagedTransport("http");
    call("manage-agent-integration", "KIMI_CODE", "REPAIR");
    expect(managedTransports()).toEqual(["stdio", "stdio", "stdio"]);
    expect(read().mcpServers.other).toEqual({ transport: "http", url: "u" });
  });

  it("配置本来就对：重复启动与「修复」都不改文件、不留备份", () => {
    boot();
    call("manage-agent-integration", "KIMI_CODE", "INSTALL");
    const bytes = readFileSync(configPath, "utf8");
    const before = backups().length;
    boot();
    call("manage-agent-integration", "KIMI_CODE", "REPAIR");
    expect(readFileSync(configPath, "utf8")).toBe(bytes);
    expect(backups().length).toBe(before);
    expect(kimiReport().mcpInstalled).toBe(true);
  });

  it("旧版单服务名：启动时迁成三个档位，原文件留备份", () => {
    const original = JSON.stringify({
      theme: { keep: true },
      mcpServers: { "ayanami-task-manager": { command: "old.exe" } },
    });
    put(configPath, original);
    boot();
    expect(Object.keys(read().mcpServers).sort()).toEqual([
      "ayanami-task-manager-actions",
      "ayanami-task-manager-core",
      "ayanami-task-manager-memory",
    ]);
    expect(read().theme).toEqual({ keep: true });
    expect(backups().map((name) => readFileSync(join(dirname(configPath), name), "utf8"))).toEqual([
      original,
    ]);
  });

  it("卸载只删 ATM 条目；之后启动不会再装回来", () => {
    put(configPath, JSON.stringify({ mcpServers: { other: { command: "other" } } }));
    boot();
    call("manage-agent-integration", "KIMI_CODE", "INSTALL");
    call("manage-agent-integration", "KIMI_CODE", "UNINSTALL");
    expect(read().mcpServers).toEqual({ other: { command: "other" } });
    boot();
    expect(read().mcpServers).toEqual({ other: { command: "other" } });
    expect(kimiReport().mcpInstalled).toBe(false);
  });
});
