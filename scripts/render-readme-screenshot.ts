/**
 * 生成 README 里的产品截图。
 *
 * 截图必须是"用起来的样子"，空项目页说明不了任何事。但真实项目不能直接放出去，
 * 所以这里起一个隔离的 daemon + 前端，喂一份脱敏的示例数据再截图：
 * 结构（阶段、状态分布、阻塞、交接、记录类型）取自真实项目，字面内容全部重写。
 *
 * 数据落在 output/ 下（已 gitignore），不碰用户本机的 ATM 数据根。
 *
 *   pnpm exec tsx scripts/render-readme-screenshot.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { chromium } from "@playwright/test";
import { PROJECT_NAME, seed } from "./readme-seed.js";

const DAEMON_PORT = 4396;
const UI_PORT = 9997;
const TOKEN = "readme-shot-token";
const API = `http://127.0.0.1:${DAEMON_PORT}/api/v1`;
const UI = `http://127.0.0.1:${UI_PORT}`;

const workspace = resolve(process.cwd());
const dataDir = resolve(workspace, "output", "readme-shot", "data");
if (!dataDir.toLowerCase().startsWith(`${workspace.toLowerCase()}${sep}`)) {
  throw new Error(`READMESHOT_DATA_OUTSIDE_WORKSPACE: ${dataDir}`);
}

const children: ChildProcess[] = [];

function launch(args: string[], env: Record<string, string>): void {
  children.push(
    spawn(process.execPath, args, {
      cwd: workspace,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ...env },
    }),
  );
}

async function waitFor(url: string, label: string, init?: RequestInit): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return;
    } catch {
      // 服务还没起来，继续轮询。
    }
    if (Date.now() > deadline) throw new Error(`TIMEOUT_WAITING_FOR: ${label}`);
    await new Promise((done) => setTimeout(done, 400));
  }
}

async function get(path: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status} ${await response.text()}`);
  return response.json();
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} -> ${response.status} ${text}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function shoot(): Promise<void> {
  const browser = await chromium.launch();
  try {
    for (const theme of ["light", "dark"] as const) {
      // 主题必须在页面脚本跑之前写进 localStorage，否则首帧是另一套配色。
      // 每种主题用独立 context 直接落到目标路由：hash 变更不会触发重新路由。
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      await context.addInitScript(`window.localStorage.setItem("atm.theme", "${theme}")`);
      const page = await context.newPage();
      await page.goto(`${UI}/#overview`);
      await page.waitForSelector(".atm-sidebar");
      await page.waitForTimeout(1_500);
      await page.screenshot({
        path: resolve(workspace, "docs", "assets", `screenshot-overview-${theme}.png`),
      });
      // 走用户的真实路径：点侧栏。直接改 hash 不会重新路由。
      await page.locator(".atm-sidebar").getByRole("button", { name: PROJECT_NAME }).click();
      await page.waitForTimeout(1_500);
      await page.screenshot({
        path: resolve(workspace, "docs", "assets", `screenshot-project-${theme}.png`),
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

try {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(resolve(workspace, "docs", "assets"), { recursive: true });

  launch(["node_modules/tsx/dist/cli.mjs", "apps/daemon/src/main.ts"], {
    ATM_DATA_DIR: dataDir,
    AYANAMI_TASK_TOKEN: TOKEN,
    AYANAMI_TASK_PORT: String(DAEMON_PORT),
  });
  launch(
    [
      "node_modules/vite/bin/vite.js",
      "--config",
      "apps/desktop/vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(UI_PORT),
      "--strictPort",
    ],
    { VITE_ATM_ENDPOINT: `http://127.0.0.1:${DAEMON_PORT}`, VITE_ATM_TOKEN: TOKEN },
  );

  await waitFor(`${API}/system/status`, "daemon", {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  await waitFor(UI, "vite");
  await seed({ uiGet: get, uiPost: post, agentPost: post });
  await shoot();
  process.stdout.write("wrote screenshot-project-light.png and screenshot-project-dark.png\n");
} finally {
  for (const child of children) if (!child.killed) child.kill();
}
