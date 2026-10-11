/**
 * 数据源冲突的选源界面（W8h，07 §7）在真实宿主上走一遍：smoke 构建的原生宿主（tao 窗口 + WebView2），
 * 经 CDP 像用户一样点。2.x 数据是 2.0 两进程版本真实写出的一份（`output/source-choice-fixture/L`，
 * 2.0 的 CLI 建了项目「演练项目」DRL 和记录 DRL-D-001）。
 *
 *   1. 首次启动：从 L 转换、发布、服务；3.0 的库里与 L 的业务内容逐条一致。
 *   2. 写 `A=legacy by setup-rollback`（回滚到 2.x 之后的样子），在 L 里放一个未登记的文件：
 *      再启动是 SOURCE_CONFLICT（UNREADABLE）。窗口自己出来、显示选源页；Agent 入口不开（没有 daemon.json）。
 *      点「沿用 3.0」→ 确认 → 服务同一个 generation，`A=v3 by user-choice`，DRL 还在。
 *   3. 换一个数据根（同样内容复制到别处）：OTHER_SOURCE。沿用不可选；「从 2.x 重新转换」→ 确认 → 新 generation，DRL 在。
 *   4. 不在冲突时 `chooseDataSource` 被宿主拒绝（SOURCE_NOT_IN_CONFLICT）。
 *
 * 全部在 output/ 下的沙箱里（合成 LOCALAPPDATA / APPDATA），不碰真实数据根与安装；令牌只在内存里。
 * 截图与报告留在 output/source-choice-smoke/，沙箱结束时删掉。
 *
 *   pnpm exec tsx scripts/source-choice-smoke.ts          # 先构建 renderer 与 smoke 宿主（debug）
 *   ATM_SMOKE_HOST_EXE=<exe> pnpm exec tsx scripts/source-choice-smoke.ts
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { assertSmokeHost } from "./package-native.js";
import { legacyBusiness, v3Business } from "./business-summary.js";
import {
  assertSandboxDataDir,
  connectRenderer,
  outputRoot,
  repoRoot,
  snapshotLoginItems,
  startSmokeHost,
  stopSmokeHost,
  waitUntil,
  type SmokeHost,
  type SmokeRenderer,
} from "./smoke-host.js";

const native = join(repoRoot, "apps", "desktop", "native");
const fixture = join(outputRoot, "source-choice-fixture", "L");
const shotsDir = assertSandboxDataDir(join(outputRoot, "source-choice-smoke"));
const sandbox = assertSandboxDataDir(join(outputRoot, "source-choice-sandbox"));
const home = join(sandbox, "home");
const legacy = join(home, "Local", "AyanamiTaskManager");
const moved = join(home, "Local", "AyanamiTaskManager-moved");
const n = join(home, "Local", "AyanamiTaskManager3");
const PROJECT = "演练项目";

const report: {
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  shots: string[];
} = { checks: [], shots: [] };

function check(name: string, passed: boolean, detail?: unknown): void {
  report.checks.push({
    name,
    passed,
    ...(passed || detail === undefined ? {} : { detail: JSON.stringify(detail).slice(0, 400) }),
  });
  process.stdout.write(
    `  ${passed ? "✓" : "✗"} ${name}${passed ? "" : `  ${JSON.stringify(detail)}`}\n`,
  );
}

function smokeHostExe(): string {
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
      // 单独的 target：`cargo test -p atm-host` 会把 target\debug 的宿主换成不带 smoke 的构建。
      CARGO_TARGET_DIR: join(native, "target-smoke"),
    });
  }
  const executable = resolve(
    given ?? join(native, "target-smoke", "debug", "AyanamiTaskManager.exe"),
  );
  if (!existsSync(executable)) throw new Error(`找不到烟测宿主：${executable}`);
  assertSmokeHost(readFileSync(executable));
  return executable;
}

function environment(dataDir?: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM3_DATA_DIR"].includes(entry[0]),
    ),
  );
  return {
    ...inherited,
    LOCALAPPDATA: join(home, "Local"),
    APPDATA: join(home, "Roaming"),
    ATM_SMOKE_CORE_USERPROFILE: home,
    ATM_DEV_REPOSITORY_ROOT: repoRoot,
    ...(dataDir ? { ATM_DATA_DIR: dataDir } : {}),
  };
}

const readJson = (path: string): Record<string, unknown> | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : null;
const generation = () => readJson(join(n, "conversion.json"))?.generation as string | undefined;
const authority = () => readJson(join(n, "authority.json"));
const descriptor = () => join(n, "runtime", "daemon.json");

/** 3.0 这一边的项目（只读打开 N 的库）。 */
const v3Projects = (): string[] => v3Business(n)?.projects ?? [];

if (!existsSync(fixture)) throw new Error(`找不到 2.x 夹具：${fixture}`);
// 先拍 Run 快照再起宿主：快照读不到时宿主还没起来，没有要收拾的。
const executable = smokeHostExe();
const loginItems = snapshotLoginItems([executable]);

async function shot(page: Page, name: string): Promise<void> {
  const path = join(shotsDir, `${name}.png`);
  await page.screenshot({ path });
  report.shots.push(path);
}

async function run(
  executable: string,
  dataDir: string | undefined,
  body: (host: SmokeHost) => Promise<void>,
): Promise<void> {
  const host = startSmokeHost({ executable, v3Dir: n, env: environment(dataDir) });
  try {
    await body(host);
  } finally {
    check("宿主干净退出", await stopSmokeHost(host, 30_000));
  }
}

/** 冲突时的选源页：在页里点选项、点继续、在确认框里确认，然后等服务开起来、侧栏出现项目。 */
async function choose(
  renderer: SmokeRenderer,
  option: "沿用 3.0" | "从 2.x 重新转换",
  shotName: string,
): Promise<void> {
  const page = renderer.page;
  await page.getByRole("heading", { name: "需要选择数据来源" }).waitFor({ timeout: 60_000 });
  await shot(page, shotName);
  await page.getByRole("radio", { name: new RegExp(`^${option.replace(".", "\\.")}`) }).click();
  await page.getByRole("button", { name: `${option}，继续` }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor({ timeout: 10_000 });
  // 等确认框的进场动效走完再截（截到一半是半透明的）。
  await page.waitForTimeout(600);
  await shot(page, `${shotName}-confirm`);
  await dialog.getByRole("button", { name: option, exact: true }).click();
  await page
    .getByRole("navigation", { name: "活动项目" })
    .getByRole("button", { name: PROJECT, exact: true })
    .waitFor({ timeout: 180_000 });
  await shot(page, `${shotName}-done`);
}

async function main(executable: string): Promise<void> {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  mkdirSync(join(home, "Roaming"), { recursive: true });
  cpSync(fixture, legacy, { recursive: true });

  process.stdout.write("[1] 首次启动：从 2.x 转换\n");
  let g1 = "";
  await run(executable, undefined, async () => {
    await waitUntil(
      async () => (existsSync(descriptor()) ? true : null),
      180_000,
      "首次转换后的服务",
    );
    g1 = generation() ?? "";
    check("转换后发布了 generation", g1.length > 0);
    const l = legacyBusiness(legacy);
    const v3 = v3Business(n);
    check("转换后两边的项目与记录逐条一致", JSON.stringify(l) === JSON.stringify(v3), { l, v3 });
    check("其中有 2.0 写的 DRL", v3Projects().includes(`DRL ${PROJECT}`));
  });

  process.stdout.write("[2] 回滚之后、2.x 比较不了：沿用 3.0\n");
  writeFileSync(
    join(n, "authority.json"),
    JSON.stringify({
      authority: "legacy",
      by: "setup-rollback",
      txn: "smoke-rollback",
      at: new Date().toISOString(),
      generation: g1,
      accepted_source_digest: null,
    }),
  );
  writeFileSync(join(legacy, "stray.bin"), "not a 2.x file");
  await run(executable, undefined, async (host) => {
    // 冲突时宿主自己把窗口拿出来（只有用户能解决）：不 requestShow。
    const renderer = await connectRenderer(host, 120_000);
    try {
      const page = renderer.page;
      await page.getByRole("heading", { name: "需要选择数据来源" }).waitFor({ timeout: 120_000 });
      check("冲突时写了启动状态", existsSync(join(n, "runtime", "startup-state.json")));
      check("冲突时 Agent 入口没开（没有 daemon.json）", !existsSync(descriptor()));
      const source = (await page.evaluate("window.ayanamiDesktop.getDataSource()")) as {
        state: string;
        cause: string;
      };
      check(
        "桥报 SOURCE_CONFLICT / UNREADABLE",
        source.state === "SOURCE_CONFLICT" && source.cause === "UNREADABLE",
        source,
      );
      check("两边都可选", (await page.getByRole("radio", { disabled: true }).count()) === 0);
      await choose(renderer, "沿用 3.0", "conflict-unreadable");
      const a = authority();
      check(
        "A=v3 by user-choice，同一个 generation",
        a?.authority === "v3" && a.by === "user-choice" && a.generation === g1,
        a,
      );
      check("沿用后服务的还是同一个 generation", generation() === g1);
      check("启动状态清掉了", !existsSync(join(n, "runtime", "startup-state.json")));
      check(
        "Agent 入口回来了（daemon.json），项目还在",
        existsSync(descriptor()) && v3Projects().includes(`DRL ${PROJECT}`),
      );
      // 错误对象的 code 过不了 CDP 边界：在页里取出来。
      const refused = (await page.evaluate(
        "window.ayanamiDesktop.chooseDataSource('RECONVERT').then(() => 'accepted', (e) => String(e.code))",
      )) as string;
      check(
        "不在冲突时选择被拒（SOURCE_NOT_IN_CONFLICT）",
        refused === "SOURCE_NOT_IN_CONFLICT",
        refused,
      );
    } finally {
      await renderer.browser.close().catch(() => undefined);
    }
  });
  rmSync(join(legacy, "stray.bin"));

  process.stdout.write("[3] 换了数据根：只能重新转换\n");
  cpSync(legacy, moved, { recursive: true });
  await run(executable, moved, async (host) => {
    const renderer = await connectRenderer(host, 120_000);
    try {
      const page = renderer.page;
      await page.getByRole("heading", { name: "需要选择数据来源" }).waitFor({ timeout: 120_000 });
      check("沿用 3.0 不可选", await page.getByRole("radio", { name: /^沿用 3\.0/u }).isDisabled());
      check(
        "重新转换已经选上",
        (await page
          .getByRole("radio", { name: /^从 2\.x 重新转换/u })
          .getAttribute("aria-checked")) === "true",
      );
      await choose(renderer, "从 2.x 重新转换", "conflict-other-source");
      const g2 = generation();
      check("重新转换出了新 generation", g2 !== undefined && g2 !== g1, { g1, g2 });
      check("A=v3 by publish（新的一代）", authority()?.by === "publish", authority());
      check("项目从新数据根转换过来", v3Projects().includes(`DRL ${PROJECT}`));
    } finally {
      await renderer.browser.close().catch(() => undefined);
    }
  });
}

let failure: unknown = null;
try {
  await loginItems.restoreAfter(() => main(executable));
} catch (error) {
  failure = error;
  check("中断", false, String(error).slice(0, 400));
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
  writeFileSync(join(shotsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
const failed = report.checks.filter((c) => !c.passed);
process.stdout.write(
  `\n${report.checks.length - failed.length}/${report.checks.length} checks passed\n`,
);
if (failure !== null || failed.length > 0) process.exit(1);
