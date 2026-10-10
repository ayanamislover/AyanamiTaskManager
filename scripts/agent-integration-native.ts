/**
 * 设置页「Agent 接入」走真实桥（ATM 3 W6d）：smoke 构建的原生宿主（WebView2）里点设置页，七个宿主方法都经
 * 宿主 → atm-agents，写的是沙箱里合成的家目录，不是本机真实的 `~/.codex`、`~/.claude.json`。
 *
 *   pnpm exec tsx scripts/agent-integration-native.ts
 *
 * - 合成家目录先放一份 2.x 的 Codex 配置（钉着 `app-2.4.0` 的宿主入口 + 一个别的 server），并建 `~/.kimi-code`。
 * - 开发布局不修复（`Gate` 关）：Codex 卡片显示待修；点「修复」后配置变成 `atm-mcp.exe --profile core|memory`，
 *   别的 server 留着，旁边有 `.bak-`，规则块与 Skills 装进合成家目录。
 * - 切换 memory profile：开发布局只记设置、不改客户端；再读一次开关是新值。
 * - MCP bridge 观测能展开（这台机器上没有合成的桥进程，读到 0 个）。
 * - 界面版 status（W6f）：单库，带这份发布物的转换状态。
 * - 截图（浅色、深色）在 `output/agent-integration-native/`，报告 `report.json`。复制按钮一个都不点：
 *   HTTP 配置里有令牌，复制会把它放进本机剪贴板。
 *
 * 给了 ATM_SMOKE_HOST_EXE 就用它（跳过构建）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { assertSmokeHost } from "./package-native.js";
import {
  assertSandboxDataDir,
  connectRenderer,
  outputRoot,
  repoRoot,
  requestShow,
  snapshotLoginItems,
  startSmokeHost,
  stopSmokeHost,
  waitUntil,
  type SmokeHost,
  type SmokeRenderer,
} from "./smoke-host.js";

const native = join(repoRoot, "apps", "desktop", "native");
const shotsDir = assertSandboxDataDir(join(outputRoot, "agent-integration-native"));
const sandboxRoot = assertSandboxDataDir(join(outputRoot, "agent-integration-native-sandbox"));
const VIEWPORT = { width: 1600, height: 1000 };
const report: {
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  shots: string[];
} = { checks: [], shots: [] };

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

function check(name: string, passed: boolean, detail?: string): void {
  report.checks.push({ name, passed, ...(detail ? { detail: detail.slice(0, 400) } : {}) });
}

function smokeHost(): string {
  const given = process.env.ATM_SMOKE_HOST_EXE;
  if (given === undefined) {
    const build = (command: string, args: string[], cwd: string, env = process.env) => {
      const result = spawnSync(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
      if (result.status !== 0)
        throw new Error(`${command} ${args.join(" ")} 失败：${result.status}`);
    };
    build(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "build", "--config", "apps/desktop/vite.config.ts"],
      repoRoot,
    );
    build("cargo", ["build", "--locked", "-p", "atm-host", "--features", "smoke"], native, {
      ...process.env,
      CARGO_TARGET_DIR: join(native, "target"),
    });
  }
  const executable = resolve(given ?? join(native, "target", "debug", "AyanamiTaskManager.exe"));
  if (!existsSync(executable)) throw new Error(`找不到烟测宿主：${executable}`);
  assertSmokeHost(readFileSync(executable));
  return executable;
}

async function shot(page: Page, name: string): Promise<void> {
  const path = join(shotsDir, `${name}.png`);
  await page.screenshot({ path });
  report.shots.push(`${name}.png`);
}

/** 把「Agent 接入」面板滚到视口上沿。 */
async function showIntegrations(page: Page): Promise<void> {
  await page
    .locator(".atm-settings-integrations")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await delay(500);
}

const codexCard = (page: Page) =>
  page
    .locator(".atm-integration-card")
    .filter({ has: page.locator("header strong", { hasText: "Codex" }) });

const CODEX_2X = [
  'model = "gpt"',
  "",
  "[mcp_servers.other]",
  'command = "other.exe"',
  "args = []",
  "",
  '[mcp_servers."ayanami-task-manager-core"]',
  'command = "C:\\\\L\\\\app-2.4.0\\\\AyanamiTaskManager.exe"',
  'args = ["--mcp-stdio", "--profile", "core"]',
  "",
].join("\n");

async function run(): Promise<void> {
  const executable = smokeHost();
  const home = assertSandboxDataDir(join(sandboxRoot, "home"));
  rmSync(home, { recursive: true, force: true, maxRetries: 2 });
  mkdirSync(join(home, "Local"), { recursive: true });
  mkdirSync(join(home, "Roaming"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".kimi-code"), { recursive: true });
  const codexConfig = join(home, ".codex", "config.toml");
  writeFileSync(codexConfig, CODEX_2X);
  const n = join(home, "Local", "AyanamiTaskManager3");
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM3_DATA_DIR"].includes(entry[0]),
    ),
  );
  const env = {
    ...inherited,
    LOCALAPPDATA: join(home, "Local"),
    APPDATA: join(home, "Roaming"),
    ATM_SMOKE_CORE_USERPROFILE: home,
    ATM_DEV_REPOSITORY_ROOT: repoRoot,
  };
  // Skills 的来源 `<L>\skills`：开发布局没有安装包，服务起来之后放一份仓库里的（启动前就建 `L` 会被当成
  // 一个要转换的 2.x 根）。
  const l = join(home, "Local", "AyanamiTaskManager");
  const seedSkills = () =>
    spawnSync(
      "robocopy",
      [
        join(repoRoot, "integrations", "skills"),
        join(l, "skills"),
        "/E",
        "/NFL",
        "/NDL",
        "/NJH",
        "/NJS",
      ],
      { windowsHide: true },
    );
  const loginItems = snapshotLoginItems([executable]);
  const host: SmokeHost = startSmokeHost({ executable, dataDir: n, env });
  try {
    await loginItems.restoreAfter(async () => {
      let renderer: SmokeRenderer | null = null;
      try {
        await waitUntil(
          async () => (existsSync(join(n, "runtime", "daemon.json")) ? true : null),
          120_000,
          "服务的 daemon.json",
        );
        seedSkills();
        await requestShow(host);
        renderer = await connectRenderer(host, 60_000);
        const page = renderer.page;
        await page.setViewportSize(VIEWPORT);
        await page.waitForSelector(".atm-shell", { timeout: 60_000 });
        await page
          .locator(".atm-sidebar")
          .getByRole("button", { name: "设置", exact: true })
          .click();
        await page.locator(".atm-integration-card").first().waitFor({ timeout: 30_000 });
        await delay(1_000);
        check(
          "四张客户端卡片",
          (await page.locator(".atm-integration-card").count()) === 4,
          String(await page.locator(".atm-integration-card").count()),
        );
        // 开发布局不修复：2.x 的 Codex 配置原样，卡片待装。
        check("开发布局不修复", readFileSync(codexConfig, "utf8") === CODEX_2X);
        const stdio = await page.evaluate(() =>
          (window as any).ayanamiDesktop.getMcpConfigs().then((c: any) => c.stdio as string),
        );
        check(
          "stdio 配置是 atm-mcp.exe 的 core + memory",
          /atm-mcp\.exe/u.test(stdio) &&
            stdio.includes('"--profile",\n        "memory"') &&
            !stdio.includes("actions"),
          stdio,
        );
        await showIntegrations(page);
        await shot(page, "agents-before-light");

        // 修复 Codex（合成家目录）。
        const card = codexCard(page);
        await card.getByRole("button", { name: /^(安装|修复|更新)$/u }).click();
        // 全部装好时卡片不再有主操作按钮（只剩预览与卸载）。
        await waitUntil(
          async () =>
            (await card.getByRole("button", { name: /^(安装|修复|更新)$/u }).count()) === 0 &&
            (await card.getByRole("button", { name: "卸载 ATM 接入" }).count()) === 1
              ? true
              : null,
          30_000,
          "Codex 装好",
          300,
        );
        await delay(800);
        const after = readFileSync(codexConfig, "utf8");
        check(
          "Codex 配置改成 3.0 形式，别的 server 留着",
          after.includes("[mcp_servers.other]") &&
            after.includes('[mcp_servers."ayanami-task-manager-memory"]') &&
            /atm-mcp\.exe/u.test(after) &&
            !after.includes("app-2.4.0"),
          after,
        );
        const backups = readdirSync(join(home, ".codex")).filter((f) =>
          f.startsWith("config.toml.bak-"),
        );
        check(
          "留了一份备份，内容是原来的",
          backups.length === 1 &&
            readFileSync(join(home, ".codex", backups[0]!), "utf8") === CODEX_2X,
          backups.join(","),
        );
        check(
          "规则块与 Skills 进了合成家目录",
          readFileSync(join(home, ".codex", "AGENTS.md"), "utf8").includes(
            "<!-- AYANAMI_TASK_MANAGER:BEGIN -->",
          ) && existsSync(join(home, ".codex", "skills", "atm-plan", "SKILL.md")),
        );
        await showIntegrations(page);
        await shot(page, "agents-after-light");

        // 切换 memory profile：开发布局只记设置。
        const toggle = page.getByTestId("memory-profile-toggle").getByRole("button");
        const before = await toggle.textContent();
        await toggle.click();
        await page
          .getByTestId("memory-profile-toggle")
          .getByRole("status")
          .waitFor({ timeout: 30_000 });
        const enabled = await page.evaluate(() =>
          (window as any).ayanamiDesktop.getMemoryProfile(),
        );
        check(
          "切换后开关是新值，客户端配置不动",
          before?.includes("已开启") === true &&
            enabled === false &&
            readFileSync(codexConfig, "utf8") === after,
          `${before} -> ${enabled}`,
        );
        await toggle.click();
        await delay(1_500);

        // MCP bridge 观测。
        const bridges = await page.evaluate(() => (window as any).ayanamiDesktop.getMcpBridges());
        check(
          "桥观测读得到（0 个合成桥）",
          bridges?.metric === "PRIVATE_BYTES" && Array.isArray(bridges.bridges),
          JSON.stringify(bridges).slice(0, 200),
        );
        // 界面版 status（W6f，06 #1、07 §7）：单库，转换状态是这份发布物（宿主交给 ui-bridge 的那一份）。
        const status = await page.evaluate(() =>
          (window as any).ayanamiDesktop
            .runtimeRequest({ path: "/api/v1/system/status", method: "GET" })
            .then((r: any) => ({ code: r.status, body: JSON.parse(r.body) })),
        );
        check(
          "界面版 status 是单库与转换状态",
          status.code === 200 &&
            status.body.layout === "single" &&
            status.body.conversion?.phase === "PUBLISHED" &&
            typeof status.body.conversion?.generation === "string" &&
            status.body.conversion.generation.length > 0 &&
            Array.isArray(status.body.projectFailures) &&
            status.body.projectFailures.length === 0,
          JSON.stringify({
            code: status.code,
            layout: status.body.layout,
            conversion: status.body.conversion,
          }),
        );
        // Agent 主体不经界面：界面上的 User 能读，错误文案以错误码开头（这里拿不存在的客户端试）。
        const refused = await page.evaluate(() =>
          (window as any).ayanamiDesktop
            .installMcp("CURSOR")
            .then(() => "ok")
            .catch((e: any) => `${e.code}|${e.message}`),
        );
        check(
          "错误码与以码开头的话",
          refused.startsWith("MCP_CLIENT_UNSUPPORTED|MCP_CLIENT_UNSUPPORTED: "),
          refused,
        );

        await page.locator(".atm-theme-toggle").click();
        await delay(800);
        await showIntegrations(page);
        await shot(page, "agents-after-dark");
        await page.locator(".atm-theme-toggle").click();
        await delay(500);
      } finally {
        await renderer?.browser.close().catch(() => undefined);
        if (!(await stopSmokeHost(host))) check("宿主干净退出", false);
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
}

rmSync(shotsDir, { recursive: true, force: true });
mkdirSync(shotsDir, { recursive: true });
mkdirSync(sandboxRoot, { recursive: true });
let failure: unknown = null;
try {
  await run();
} catch (error) {
  failure = error;
  check("中断", false, String(error));
} finally {
  rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 3 });
  writeFileSync(join(shotsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
const failed = report.checks.filter((c) => !c.passed);
process.stdout.write(
  `${report.checks.length - failed.length}/${report.checks.length} checks, ${report.shots.length} shots\n` +
    failed.map((c) => `FAIL ${c.name}: ${c.detail ?? ""}`).join("\n") +
    "\n",
);
if (failure !== null || failed.length > 0) process.exit(1);
