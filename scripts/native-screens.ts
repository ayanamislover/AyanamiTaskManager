/**
 * 逐页截图对照（ATM 3 W5i）：同一份示例数据（`scripts/readme-seed.ts`，README 截图那份）、同一套界面，
 * 分别跑在两个后端上，按用户的路径点进每一页截图，两边同名的图逐张对照。
 *
 *   --backend v2  2.0 开发版 daemon + vite（与 README 截图脚本同一种起法），无头 Chromium。
 *   --backend v3  3.0 smoke 构建的原生宿主（tao 窗口 + WebView2），经 CDP 驱动真实窗口。
 *
 *   pnpm exec tsx scripts/native-screens.ts --backend v3
 *
 * 两边都在 output/ 下的沙箱里起（数据根、合成 home、示例 git 仓库），不碰本机真实的 ATM 数据根与安装；
 * 结束时删掉沙箱，只留截图（output/native-screens/<backend>/）与报告（report.json）。
 * 令牌只在内存里：v2 每次随机生成，v3 从沙箱的 daemon.json 读，不打印、不写进报告。
 * v3 给了 ATM_SMOKE_HOST_EXE 就用它（跳过构建）。
 */
// 先于一切：这里拉起的宿主窗口不抢焦点、压在最底层（scripts/test-windows.ts）。
import "./test-windows.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { assertSmokeHost } from "./package-native.js";
import { PROJECT_NAME, seed, type SeedIo } from "./readme-seed.js";
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

type Backend = "v2" | "v3";
const backend = ((): Backend => {
  const at = process.argv.indexOf("--backend");
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (value !== "v2" && value !== "v3") throw new Error("用法：--backend v2 | v3");
  return value;
})();

const native = join(repoRoot, "apps", "desktop", "native");
const shotsDir = assertSandboxDataDir(join(outputRoot, "native-screens", backend));
const sandboxRoot = assertSandboxDataDir(join(outputRoot, "native-screens-sandbox", backend));
const repoDir = join(sandboxRoot, "repo");
const VIEWPORT = { width: 1600, height: 1000 };
const STAT_NAME = "工程统计示例";
const DRAWER_TASK = "重写等轴相机的拖拽与选中判定";
const KNOWLEDGE_TITLE = "WAL 文件只涨不缩时先查长读事务";
const QUICK_TITLE = "整理发布说明里的截图清单";
const report: { backend: Backend; shots: string[]; problems: string[] } = {
  backend,
  shots: [],
  problems: [],
};

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

function json(
  url: string,
  token: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((done, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = { raw: text.slice(0, 300) };
          }
          done({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    request.on("error", fail);
    request.end(payload);
  });
}

function ok(path: string, answer: { status: number; body: unknown }): Record<string, unknown> {
  if (answer.status < 200 || answer.status >= 300)
    throw new Error(`${path} -> ${answer.status} ${JSON.stringify(answer.body).slice(0, 400)}`);
  return (answer.body ?? {}) as Record<string, unknown>;
}

/** 以用户身份经界面桥调用（3.0：进程内的 ui-bridge；用户凭证不出宿主）。 */
async function bridge(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const answer = (await page.evaluate(
    (request) => (window as any).ayanamiDesktop.runtimeRequest(request),
    {
      method,
      path,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    },
  )) as { status: number; body: string };
  return { status: answer.status, body: answer.body ? JSON.parse(answer.body) : null };
}

function git(dir: string, args: string[]): void {
  const result = spawnSync(
    "git",
    ["-c", "user.name=示例", "-c", "user.email=demo@example.invalid", ...args],
    { cwd: dir, stdio: "ignore", windowsHide: true },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${result.status}`);
}

/** 工程统计用的示例仓库：两次提交加一个未提交的新文件。 */
function sampleRepository(): void {
  rmSync(repoDir, { recursive: true, force: true });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  mkdirSync(join(repoDir, "tests"), { recursive: true });
  git(repoDir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repoDir, "package.json"), '{"dependencies":{"three":"1"}}\n');
  writeFileSync(
    join(repoDir, "src", "scene.ts"),
    "export const scene = 1;\nexport const camera = 2;\n",
  );
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", "init"]);
  writeFileSync(join(repoDir, "src", "gesture.ts"), "export function drag() {}\n".repeat(12));
  writeFileSync(join(repoDir, "tests", "gesture.test.ts"), "test('drag', () => {});\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", "gesture"]);
  writeFileSync(join(repoDir, "src", "overlay.ts"), "export const fps = 60;\n");
}

/** README 那份数据之外：一个有源码目录的项目，工程统计面板要它。 */
async function extraSeed(io: SeedIo): Promise<void> {
  sampleRepository();
  await io.uiPost("/projects", {
    name: STAT_NAME,
    code: "STAT",
    sourcePath: repoDir,
    description: "示例数据：工程统计。",
  });
  // 知识库与临时任务各一条：两页要对照的是有内容时的样子，不只是空态。
  await io.uiPost("/quick-tasks", { title: QUICK_TITLE, note: "", actor: "USER" });
  await io.uiPost("/knowledge", {
    opId: "seed-knowledge-wal",
    expectedVersion: 0,
    slug: "sqlite-wal-checkpoint",
    title: KNOWLEDGE_TITLE,
    summary: "长读事务会挡住 checkpoint，WAL 文件只涨不缩；读完就结束事务。",
    useWhen: "WAL 文件持续变大、磁盘占用异常时",
    tags: ["sqlite", "wal"],
    bodyMarkdown:
      "## 现象\n\nWAL 文件持续变大。\n\n## 原因\n\n有读事务一直没结束，checkpoint 无法越过它。\n\n## 处理\n\n- 读完立即结束事务\n- 必要时手动 `PRAGMA wal_checkpoint(TRUNCATE)`\n",
  });
}

async function click(page: Page, name: string, locate: () => ReturnType<Page["locator"]>) {
  try {
    await locate().click({ timeout: 40_000 });
  } catch (error) {
    report.problems.push(`点不到「${name}」：${String(error).slice(0, 200)}`);
    return false;
  }
  await delay(1_500);
  return true;
}

const sidebar = (page: Page) => page.locator(".atm-sidebar");

async function theme(page: Page, wanted: "light" | "dark"): Promise<void> {
  const current = await page.evaluate(() => document.documentElement.dataset.theme);
  if (current !== wanted) {
    await page.locator(".atm-theme-toggle").click();
    await delay(800);
  }
}

/**
 * 截一张。默认先把页面滚回顶部：上一页的滚动位置会留下来（暗色项目页曾继承设置页滚到底的位置，
 * 两端截到的不是同一块，peer W5 r1）。要截页尾的（工程统计、设置下半屏）传 `keepScroll`。
 */
async function shot(page: Page, name: string, keepScroll = false): Promise<void> {
  if (!keepScroll) {
    await page.evaluate(() => {
      for (const el of [document.scrollingElement, ...document.querySelectorAll("*")])
        if (el && el.scrollTop > 0) el.scrollTop = 0;
    });
    await delay(300);
  }
  const path = join(shotsDir, `${name}.png`);
  await page.screenshot({ path });
  report.shots.push(`${name}.png`);
}

/** 每一页的点法都与用户一样：点侧栏、点任务、点按钮。 */
async function shots(page: Page): Promise<void> {
  await page.setViewportSize(VIEWPORT);
  await page.waitForSelector(".atm-sidebar", { timeout: 60_000 });
  await delay(1_500);
  for (const mode of ["light", "dark"] as const) {
    await theme(page, mode);
    const nav = async (label: string) => {
      // 「工作区」那一组默认折叠：先展开。
      const disclosure = sidebar(page).locator(".atm-nav-disclosure");
      if (
        (await sidebar(page).getByRole("button", { name: label, exact: true }).count()) === 0 ||
        ((await disclosure.count()) > 0 &&
          (await disclosure.getAttribute("aria-expanded")) === "false" &&
          !["总览", "项目"].includes(label))
      )
        await disclosure.click().catch(() => undefined);
      return click(page, label, () =>
        sidebar(page).getByRole("button", { name: label, exact: true }),
      );
    };
    if (await nav("总览")) await shot(page, `overview-${mode}`);
    if (
      await click(page, PROJECT_NAME, () =>
        page
          .getByRole("navigation", { name: "活动项目" })
          .getByRole("button", { name: PROJECT_NAME, exact: true }),
      )
    ) {
      await shot(page, `project-${mode}`);
      if (await click(page, DRAWER_TASK, () => page.getByText(DRAWER_TASK).first())) {
        await shot(page, `task-drawer-${mode}`);
        await page.keyboard.press("Escape");
        await delay(800);
      }
    }
    if (
      await click(page, STAT_NAME, () =>
        page
          .getByRole("navigation", { name: "活动项目" })
          .getByRole("button", { name: STAT_NAME, exact: true }),
      )
    ) {
      // 工程统计在页尾默认折叠的「诊断」区里，面板本身也默认折叠。
      for (const label of ["展开项目诊断", "展开工程统计"]) {
        const expand = page.getByRole("button", { name: label });
        if ((await expand.count()) > 0) {
          await expand.first().click();
          await delay(800);
        }
      }
      const refresh = page.getByRole("button", { name: "刷新统计" });
      if ((await refresh.count()) > 0) {
        await refresh.first().click();
        await page
          .getByText("Source LOC")
          .first()
          .waitFor({ timeout: 30_000 })
          .catch(() => report.problems.push(`${mode}：刷新统计之后没有出现 Source LOC`));
      } else report.problems.push(`${mode}：找不到「刷新统计」`);
      await delay(800);
      // 统计数值在页尾：把它们滚到视口中间，截图里要看得到数，不只是面板标题。
      await page
        .getByText("Source LOC")
        .first()
        .evaluate((el) => el.scrollIntoView({ block: "center" }))
        .catch(() => undefined);
      await delay(400);
      await shot(page, `engineering-${mode}`, true);
    }
    if (mode === "light")
      for (const [label, name] of [
        ["项目", "projects"],
        ["知识库", "knowledge"],
        ["活动任务", "my"],
        ["临时任务", "quick"],
        ["阻塞与等待", "blockers"],
        ["Agent", "agents"],
        ["全局时间线", "timeline"],
      ] as const)
        if (await nav(label)) {
          // 知识库要看条目详情：点开那一条。
          if (name === "knowledge")
            await click(page, KNOWLEDGE_TITLE, () => page.getByText(KNOWLEDGE_TITLE).first());
          await shot(page, `${name}-${mode}`);
        }
    if (
      await click(page, "设置", () =>
        sidebar(page).getByRole("button", { name: "设置", exact: true }),
      )
    ) {
      await shot(page, `settings-${mode}`);
      if (mode === "light") {
        // 下半页（自动备份、启动行为）在首屏之外：滚到底再截一张。
        await page.evaluate(() => {
          for (const el of [document.scrollingElement, ...document.querySelectorAll("*")])
            if (el && el.scrollHeight > el.clientHeight + 10) el.scrollTop = el.scrollHeight;
        });
        await delay(600);
        await shot(page, `settings-bottom-${mode}`, true);
      }
    }
  }
}

// ---------- v2：2.0 开发版 daemon + vite ----------

async function runV2(): Promise<void> {
  const dataDir = join(sandboxRoot, "data");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const token = randomUUID();
  const [daemonPort, uiPort] = [await freePort(), await freePort()];
  const children: ChildProcess[] = [];
  const launch = (args: string[], env: Record<string, string>) =>
    children.push(
      spawn(process.execPath, args, {
        cwd: repoRoot,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, ...env },
      }),
    );
  const api = `http://127.0.0.1:${daemonPort}/api/v1`;
  let browser: Browser | null = null;
  try {
    launch(["node_modules/tsx/dist/cli.mjs", "apps/daemon/src/main.ts"], {
      ATM_DATA_DIR: dataDir,
      AYANAMI_TASK_TOKEN: token,
      AYANAMI_TASK_PORT: String(daemonPort),
    });
    launch(
      [
        "node_modules/vite/bin/vite.js",
        "--config",
        "apps/desktop/vite.config.ts",
        "--host",
        "127.0.0.1",
        "--port",
        String(uiPort),
        "--strictPort",
      ],
      { VITE_ATM_ENDPOINT: `http://127.0.0.1:${daemonPort}`, VITE_ATM_TOKEN: token },
    );
    await waitUntil(
      async () =>
        (await json(`${api}/system/status`, token, "GET").catch(() => ({ status: 0 }))).status ===
        200
          ? true
          : null,
      120_000,
      "2.0 daemon",
      400,
    );
    await waitUntil(
      async () => ((await fetch(`http://127.0.0.1:${uiPort}`).catch(() => null))?.ok ? true : null),
      120_000,
      "vite",
      400,
    );
    const io: SeedIo = {
      uiGet: async (path) => ok(path, await json(`${api}${path}`, token, "GET")),
      uiPost: async (path, body) => ok(path, await json(`${api}${path}`, token, "POST", body)),
      agentPost: async (path, body) => ok(path, await json(`${api}${path}`, token, "POST", body)),
    };
    await seed(io);
    await extraSeed(io);
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    await page.goto(`http://127.0.0.1:${uiPort}/#overview`);
    await shots(page);
  } finally {
    await browser?.close().catch(() => undefined);
    for (const child of children) if (!child.killed) child.kill();
    await delay(1_000);
  }
}

// ---------- v3：smoke 构建的原生宿主 ----------

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

async function runV3(): Promise<void> {
  const executable = smokeHost();
  const home = assertSandboxDataDir(join(sandboxRoot, "home"));
  rmSync(home, { recursive: true, force: true, maxRetries: 2 });
  mkdirSync(join(home, "Local"), { recursive: true });
  mkdirSync(join(home, "Roaming"), { recursive: true });
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
  const loginItems = snapshotLoginItems([executable]);
  const host: SmokeHost = startSmokeHost({ executable, v3Dir: n, env });
  try {
    await loginItems.restoreAfter(async () => {
      let renderer: SmokeRenderer | null = null;
      try {
        await waitUntil(
          async () => (existsSync(join(n, "runtime", "daemon.json")) ? true : null),
          120_000,
          "服务的 daemon.json",
        );
        const agent = JSON.parse(readFileSync(join(n, "runtime", "daemon.json"), "utf8")) as {
          endpoint: string;
          token: string;
        };
        await requestShow(host);
        renderer = await connectRenderer(host, 60_000);
        const page = renderer.page;
        await page.waitForSelector(".atm-shell", { timeout: 60_000 });
        const api = `${agent.endpoint}/api/v1`;
        const io: SeedIo = {
          uiGet: async (path) => ok(path, await bridge(page, "GET", `/api/v1${path}`)),
          uiPost: async (path, body) =>
            ok(path, await bridge(page, "POST", `/api/v1${path}`, body)),
          agentPost: async (path, body) =>
            ok(path, await json(`${api}${path}`, agent.token, "POST", body)),
        };
        await seed(io);
        await extraSeed(io);
        // 灌完数据关窗再开：界面从头加载，侧栏与各页拿到的就是灌好的数据（不等 30 秒一轮的刷新）。
        const closed = new Promise<void>((done) => {
          renderer?.browser.on("disconnected", () => done());
          setTimeout(done, 20_000);
        });
        await page.evaluate("window.ayanamiDesktop.closeWindow()").catch(() => undefined);
        await closed;
        await renderer.browser.close().catch(() => undefined);
        await requestShow(host);
        renderer = await connectRenderer(host, 60_000);
        await shots(renderer.page);
      } finally {
        await renderer?.browser.close().catch(() => undefined);
        if (!(await stopSmokeHost(host))) report.problems.push("宿主没有干净退出");
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
  if (backend === "v2") await runV2();
  else await runV3();
} catch (error) {
  failure = error;
  report.problems.push(`中断：${String(error).slice(0, 500)}`);
} finally {
  rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 3 });
  writeFileSync(join(shotsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(
  `${backend}: ${report.shots.length} shots, ${report.problems.length} problems\n${report.problems.join("\n")}\n`,
);
if (failure !== null) process.exit(1);
