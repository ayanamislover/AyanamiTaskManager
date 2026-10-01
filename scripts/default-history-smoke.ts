/**
 * 历史数据烟测：原生 smoke 宿主打开一份已有历史的数据根，界面能读回项目与记录。
 *
 * Electron 时代这条脚本直接打开用户真实的默认数据根（%LOCALAPPDATA%\AyanamiTaskManager）。
 * 现在只认显式的沙箱：ATM_DATA_DIR 必须指到仓库 output/ 下，真实数据根与真实安装一律拒绝。
 * 沙箱里还没有历史就先以用户身份种一份，再完整重启一次宿主——读回的是落盘后的历史，
 * 不是刚写进内存的那份。
 *
 *   $env:ATM_DATA_DIR = "output/history-smoke-data"; pnpm smoke:history
 *
 * 截图写 output/playwright/default-history-restored.png，报告写 output/history-smoke-report.json。
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rendererPost } from "./renderer-user-request.js";
import {
  CheckLog,
  assertSandboxDataDir,
  connectRenderer,
  outputRoot,
  prepareSandbox,
  requestShow,
  runtimeFile,
  smokeExecutable,
  startSmokeHost,
  stopSmokeHost,
  waitForRuntime,
  withLoginItemsRestored,
  type SmokeHost,
  type SmokeRenderer,
  type SmokeRuntime,
} from "./smoke-host.js";

const PROJECT = { name: "AyanamiTaskManager 自举验收", code: "ATM" };
const RECORDS = ["完成版 GitHub 与云端 CI 全绿", "无边框本地 EXE 全链路实测通过"];

const explicitDataDir = process.env.ATM_DATA_DIR;
if (!explicitDataDir)
  throw new Error(
    '历史烟测只在显式沙箱上运行：设置 ATM_DATA_DIR 指到 output/ 下，例如 $env:ATM_DATA_DIR = "output/history-smoke-data"',
  );
// 先于任何文件操作判定：真实数据根、真实安装、output/ 以外的路径都在这里被拒。
const dataDir = assertSandboxDataDir(explicitDataDir);
const executable = smokeExecutable();
const screenshot = join(outputRoot, "playwright", "default-history-restored.png");
const reportPath = join(outputRoot, "history-smoke-report.json");
const log: CheckLog = new CheckLog();
const check: CheckLog["check"] = (name, condition, detail) => log.check(name, condition, detail);
await mkdir(join(outputRoot, "playwright"), { recursive: true });
// fresh: false——沙箱里已有的历史正是要验的东西，不能清。
const sandbox = await prepareSandbox("history-smoke", { dataDir, fresh: false });

async function systemStatus(
  runtime: SmokeRuntime,
): Promise<{ ok?: boolean; projectCount?: number }> {
  const response = await fetch(`${runtime.endpoint}/api/v1/system/status`, {
    headers: { authorization: `Bearer ${runtime.token}` },
  });
  if (!response.ok) throw new Error(`读取服务状态失败：${response.status}`);
  return (await response.json()) as { ok?: boolean; projectCount?: number };
}

async function open(host: SmokeHost): Promise<{ runtime: SmokeRuntime; renderer: SmokeRenderer }> {
  const runtime = await waitForRuntime(host);
  await requestShow(host);
  const renderer = await connectRenderer(host);
  await renderer.page.waitForSelector(".atm-shell");
  return { runtime, renderer };
}

/** 以用户身份（renderer → 宿主 → core 注入用户凭证）种一份最小历史。 */
async function seed(renderer: SmokeRenderer): Promise<void> {
  const post = (path: string, body: unknown) => rendererPost(renderer.page, path, body);
  await post("/api/v1/projects", { ...PROJECT, sourcePath: null, description: "历史烟测种子" });
  for (const [index, title] of RECORDS.entries())
    await post(`/api/v1/projects/${PROJECT.code}/ui/records`, {
      opId: `history-smoke-seed-${index}`,
      kind: "FACT",
      title,
      summary: "历史烟测种下的记录，重启后应原样读回。",
    });
}

let host = startSmokeHost({ executable, dataDir: sandbox.dataDir, env: sandbox.env });
let renderer: SmokeRenderer | null = null;
let error: unknown;
let seeded = false;
let projectCount: number | undefined;
try {
  await withLoginItemsRestored(async () => {
    try {
      let opened = await open(host);
      renderer = opened.renderer;
      if ((await systemStatus(opened.runtime)).projectCount === 0) {
        seeded = true;
        await seed(opened.renderer);
        await opened.renderer.browser.close();
        renderer = null;
        log.record("种子写入后宿主干净退出", await stopSmokeHost(host), host.stderr.join(""));
        host = startSmokeHost({ executable, dataDir: sandbox.dataDir, env: sandbox.env });
        opened = await open(host);
        renderer = opened.renderer;
      }
      const page = opened.renderer.page;
      const projectButton = page
        .getByRole("button", { name: new RegExp(PROJECT.name, "u") })
        .first();
      await projectButton.waitFor({ state: "visible", timeout: 15_000 });
      await projectButton.click();
      await page.getByRole("region", { name: "项目管理摘要" }).waitFor({ state: "visible" });
      await page
        .getByRole("tablist", { name: "项目任务视图" })
        .getByRole("tab", { name: "记录", exact: true })
        .click();
      for (const title of RECORDS) {
        const visible = await page
          .getByText(title, { exact: true })
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        check(`记录「${title}」从历史读回`, visible);
      }
      await page.screenshot({ path: screenshot });
      const status = await systemStatus(opened.runtime);
      projectCount = status.projectCount;
      check(
        "服务健康且历史里恰有这一个项目",
        status.ok === true && status.projectCount === 1,
        JSON.stringify(status),
      );
    } finally {
      await (renderer as SmokeRenderer | null)?.browser.close().catch(() => undefined);
      log.record("--smoke-quit 干净退出", await stopSmokeHost(host), host.stderr.join(""));
      log.record("退出后运行时文件已清理", !existsSync(runtimeFile(sandbox.dataDir)));
    }
  });
} catch (caught) {
  error = caught;
}
const passed = error === undefined && log.failed.length === 0;
const report = {
  passed,
  executable,
  dataDir: sandbox.dataDir,
  seeded,
  projectCount,
  screenshot,
  completedAt: new Date().toISOString(),
  checks: log.checks,
  ...(error === undefined
    ? {}
    : { error: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!passed) process.exitCode = 1;
