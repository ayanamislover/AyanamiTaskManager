/**
 * 窗口烟测：在原生 smoke 宿主（tao 窗口 + WebView2）上验收窗口行为。
 *
 * 宿主不再是 Electron：窗口状态、尺寸与命中测试走 Win32（scripts/native-window.ps1 常驻探针），
 * 界面走 WebView2 的 CDP（只有 smoke 构建开端口）。窗口按钮走界面真正的桥
 * （window.ayanamiDesktop.minimizeWindow 等），恢复、重新打开走用户真正的路径：再点一次入口
 * （第二实例把 SHOW 交给正在运行的宿主）。
 *
 *   pnpm smoke:window
 *
 * 数据根固定在 output/window-smoke-data，报告写 output/window-smoke-report.json，
 * 截图写 output/playwright/。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { rendererPost } from "./renderer-user-request.js";
import {
  HTCAPTION,
  HTCLIENT,
  NativeWindowProbe,
  cssPointToScreen,
  type NativeWindowState,
} from "./native-window.js";
import {
  CheckLog,
  connectRenderer,
  openProjectFromSidebar,
  outputRoot,
  prepareSandbox,
  readRuntime,
  requestShow,
  runtimeFile,
  smokeExecutable,
  startSmokeHost,
  stopSmokeHost,
  waitForRuntime,
  waitUntil,
  snapshotLoginItems,
  exited,
  type SmokeHost,
  type SmokeRenderer,
} from "./smoke-host.js";
import {
  DEFAULT_WINDOW_SIZE,
  MINIMUM_WINDOW_SIZE,
  expectedInitialWindowSize,
  initialWindowSizeAcceptable,
  logicalWindowSize,
  windowSizeMatches,
} from "./window-smoke-sizing.js";

const executable = smokeExecutable();
const screenshotDir = join(outputRoot, "playwright");
const screenshot = join(screenshotDir, "packaged-window-polish.png");
const drawerScreenshot = join(screenshotDir, "packaged-window-drawer-safe-area.png");
const reportPath = join(outputRoot, "window-smoke-report.json");
/** 缩放验收用的尺寸：介于最小与默认之间，确认 WebView 跟着宿主窗口走。 */
const RESIZED = { width: 1280, height: 800 };

const log: CheckLog = new CheckLog();
const check: CheckLog["check"] = (name, condition, detail) => log.check(name, condition, detail);
// 先拍 Run 快照，再起探针和宿主：读不到就什么都不启动。
const loginItems = snapshotLoginItems();
const probe = NativeWindowProbe.start();
await mkdir(screenshotDir, { recursive: true });
const sandbox = await prepareSandbox("window-smoke");

/** 宿主唯一的应用窗口；没有就是 null（后台运行或窗口已关）。 */
const appWindow = (host: SmokeHost) => probe.appWindow(host.pid);

async function visibleWindow(host: SmokeHost, label: string): Promise<NativeWindowState> {
  return waitUntil(
    async () => {
      const state = await appWindow(host);
      return state?.visible ? state : null;
    },
    20_000,
    label,
    50,
  );
}

/**
 * 原生命中测试：元素中心点换成屏幕物理像素，像系统分发鼠标那样一路问到最深的子窗口。
 * drag 区域由 WebView2 的拖拽子窗口认领（HTCAPTION），其余落到渲染窗口（HTCLIENT）。
 */
async function expectNativeRegion(
  page: Page,
  nativeWindow: NativeWindowState,
  selector: string,
  expectedRegion: "drag" | "no-drag",
  expectedHit: number,
): Promise<void> {
  const target = page.locator(selector).first();
  const region = await target.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("-webkit-app-region"),
  );
  check(`${selector} 的 app-region 是 ${expectedRegion}`, region === expectedRegion, region);
  const box = await target.boundingBox();
  check(`${selector} 可见`, box !== null);
  const devicePixelRatio = await page.evaluate(() => globalThis.devicePixelRatio);
  // 每次现读客户区位置：窗口在两次探测之间可能被挪过。
  const current = await probe.state(nativeWindow.hwnd);
  const point = cssPointToScreen(
    current.client,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    devicePixelRatio,
  );
  const hit = await probe.hitTest(nativeWindow.hwnd, point);
  check(
    `${selector} 原生命中为 ${expectedHit === HTCAPTION ? "HTCAPTION" : "HTCLIENT"}`,
    hit.hit === expectedHit,
    JSON.stringify({
      point,
      ...hit,
      // 不符时把每个子窗口对这个点的回答一起写进报告，定位是哪一层认领错了。
      ...(hit.hit === expectedHit
        ? {}
        : { children: await probe.children(nativeWindow.hwnd, point) }),
    }),
  );
}

async function runSmoke(host: SmokeHost): Promise<Record<string, unknown>> {
  let renderer: SmokeRenderer | null = null;
  try {
    const runtime = await waitForRuntime(host);
    const backgroundWindows = await probe.windows(host.pid);
    check(
      "后台启动不建应用窗口",
      backgroundWindows.every((entry) => !entry.visible),
      JSON.stringify(backgroundWindows),
    );

    // 用户再点一次入口：窗口先隐藏着建出来，等页面加载完且 renderer 报到才显示，不闪白。
    await requestShow(host);
    const timeline: Array<{ atMs: number; state: "none" | "hidden" | "visible" }> = [];
    const showStartedAt = Date.now();
    const shown = await waitUntil(
      async () => {
        const state = await appWindow(host);
        timeline.push({
          atMs: Date.now() - showStartedAt,
          state: state === null ? "none" : state.visible ? "visible" : "hidden",
        });
        return state?.visible ? state : null;
      },
      20_000,
      "SHOW 后窗口可见",
      20,
    );
    const firstSeen = timeline.find((entry) => entry.state !== "none");
    check(
      "SHOW 后窗口先以隐藏状态建出，渲染就绪后才显示",
      firstSeen?.state === "hidden",
      JSON.stringify(timeline.filter((entry, index) => index < 3 || entry.state === "visible")),
    );
    renderer = await connectRenderer(host);
    let page = renderer.page;
    check(
      "窗口显示时界面已渲染",
      (await page.locator(".atm-shell").count()) === 1,
      await page.url(),
    );
    check(
      "界面跑在原生宿主上（html[data-atm-desktop]）",
      (await page.evaluate(() => document.documentElement.dataset.atmDesktop)) === "true",
    );
    await page.locator(".atm-brand img").waitFor({ state: "visible" });
    await page.getByRole("toolbar", { name: "窗口控制" }).waitFor({ state: "visible" });

    const initialLogical = logicalWindowSize(shown.client, shown.dpi);
    const monitorLogical = logicalWindowSize(shown.monitor, shown.dpi);
    check(
      "初始客户区符合宿主默认尺寸（放不下时不小于最小、不超出显示器）",
      initialWindowSizeAcceptable(initialLogical, monitorLogical),
      JSON.stringify({
        initialLogical,
        expected: expectedInitialWindowSize(monitorLogical),
        monitorLogical,
        dpi: shown.dpi,
      }),
    );
    const minTrack = logicalWindowSize(await probe.minTrackSize(shown.hwnd), shown.dpi);
    check(
      "拖边框的最小尺寸是宿主约定的最小窗口",
      windowSizeMatches(minTrack, MINIMUM_WINDOW_SIZE),
      JSON.stringify({ minTrack, expected: MINIMUM_WINDOW_SIZE }),
    );
    await log.eventually(
      "导航按钮文字不可选中",
      () =>
        page
          .locator(".atm-nav button")
          .first()
          .evaluate((element) => getComputedStyle(element).userSelect),
      (value) => value === "none",
    );

    await expectNativeRegion(page, shown, '[data-testid="window-drag-brand"]', "drag", HTCAPTION);
    await expectNativeRegion(page, shown, ".atm-titlebar-drag", "drag", HTCAPTION);
    await expectNativeRegion(page, shown, ".atm-search-button", "no-drag", HTCLIENT);

    await page.getByRole("button", { name: /搜索任务、记录和项目/u }).click();
    await log.eventually(
      "全局搜索对话框可打开",
      () => page.getByRole("dialog", { name: "全局搜索" }).isVisible(),
      Boolean,
    );
    await page.keyboard.press("Escape");
    const themeBefore = await page.locator("html").getAttribute("data-theme");
    await page.getByRole("button", { name: /切换至.+模式/u }).click();
    await log.eventually(
      "主题可切换",
      () => page.locator("html").getAttribute("data-theme"),
      (value) => value !== themeBefore,
    );

    await expectNativeRegion(page, shown, '[data-testid="window-minimize"]', "no-drag", HTCLIENT);
    await expectNativeRegion(page, shown, '[data-testid="window-maximize"]', "no-drag", HTCLIENT);
    await expectNativeRegion(page, shown, '[data-testid="window-close"]', "no-drag", HTCLIENT);

    // 走侧栏导航，不改 hash 再 reload：宿主只放行入口文档本身的导航，带 hash 的 reload 会被拦下。
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const criticalNotifications = page.getByRole("radio", { name: /仅严重事件/u });
    await criticalNotifications.click();
    await page.getByRole("button", { name: "保存设置" }).click();
    await log.eventually(
      "设置保存提示出现",
      () => page.getByText("设置已保存", { exact: true }).isVisible(),
      Boolean,
    );
    const settingsResponse = await fetch(`${runtime.endpoint}/api/v1/settings`, {
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    const storedSettings = (await settingsResponse.json()) as Array<{
      key: string;
      value: unknown;
    }>;
    const storedNotificationMode = settingsResponse.ok
      ? storedSettings.find((setting) => setting.key === "notification.mode")?.value
      : undefined;
    check(
      "通知模式经界面保存后服务端读回 CRITICAL",
      storedNotificationMode === "CRITICAL",
      `${settingsResponse.status} ${String(storedNotificationMode)}`,
    );

    // 搭数据要以用户身份写（/ui/*），daemon.json 的 Agent 凭证会被拒，所以经 renderer 走。
    const post = (path: string, body: unknown): Promise<any> => rendererPost(page, path, body);
    await post("/api/v1/projects", {
      name: "窗口安全区验收",
      sourcePath: null,
      code: "WIN",
      description: "原生宿主抽屉验收",
    });
    const objective = await post("/api/v1/projects/WIN/ui/objectives", {
      opId: "window-smoke-objective",
      title: "验证窗口控件",
      description: "",
      definitionOfDone: [],
    });
    await post("/api/v1/projects/WIN/ui/work-items", {
      opId: "window-smoke-task",
      items: [
        {
          clientRef: "drawer-safe-area",
          objectiveId: objective.id,
          title: "验证窗口控制安全区",
          status: "READY",
          priority: "HIGH",
          acceptance: [],
          checklist: [],
        },
      ],
    });
    await openProjectFromSidebar(page, "窗口安全区验收");
    await page
      .getByRole("button", { name: /验证窗口控制安全区/u })
      .first()
      .click();
    const drawer = page.getByRole("dialog", { name: "任务详情" });
    await drawer.waitFor({ state: "visible" });
    await drawer.getByRole("heading", { name: "验证窗口控制安全区" }).waitFor();
    await log.eventually(
      "任务抽屉滑入到位",
      () =>
        drawer.evaluate((element) => {
          const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
          return Math.abs(matrix.m41) < 0.5;
        }),
      Boolean,
    );
    const drawerBox = await drawer.boundingBox();
    // 按钮不在时 boundingBox 会一直等到超时；限时并记成 null，让下面那条断言给出名字。
    const drawerCollapseBox = await drawer
      .getByRole("button", { name: "收起任务详情" })
      .boundingBox({ timeout: 5_000 })
      .catch(() => null);
    check("任务抽屉与左侧收起按钮可见", drawerBox !== null && drawerCollapseBox !== null);
    check(
      "抽屉没有右上角的关闭按钮（右上角留给窗口控件）",
      (await drawer.getByRole("button", { name: "关闭", exact: true }).count()) === 0,
    );
    const drawerLayout = await drawer.locator(".atm-drawer-head").evaluate((element) => ({
      desktop: document.documentElement.dataset.atmDesktop,
      paddingRight: getComputedStyle(element).paddingRight,
      paddingLeft: getComputedStyle(element).paddingLeft,
      box: element.getBoundingClientRect().toJSON(),
    }));
    await page.screenshot({ path: drawerScreenshot });
    const leftOffset = drawerCollapseBox.x - drawerBox.x;
    check(
      "抽屉收起按钮贴合左边缘且命中区不小于 44px",
      Math.abs(leftOffset) <= 1 && drawerCollapseBox.width >= 44 && drawerCollapseBox.height >= 44,
      JSON.stringify({ drawerBox, drawerCollapseBox, drawerLayout, leftOffset }),
    );
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });

    // 窗口按钮走界面真正调用的桥；状态以 Win32 为准，不信界面自己报的。
    const maximize = page.getByTestId("window-maximize");
    await maximize.click();
    await log.eventually(
      "最大化按钮让窗口最大化",
      async () => (await probe.state(shown.hwnd)).maximized,
      Boolean,
      5_000,
    );
    await maximize.click();
    await log.eventually(
      "再点一次还原",
      async () => (await probe.state(shown.hwnd)).maximized,
      (maximized) => !maximized,
      5_000,
    );
    await page.getByTestId("window-minimize").click();
    await log.eventually(
      "最小化按钮让窗口最小化",
      async () => (await probe.state(shown.hwnd)).minimized,
      Boolean,
      5_000,
    );
    await requestShow(host);
    await log.eventually(
      "再点一次入口从最小化恢复",
      () => probe.state(shown.hwnd),
      (state) => state.visible && !state.minimized,
      5_000,
    );

    // 改的是宿主窗口外框（用户拖边框的效果），WebView 必须跟着变；外框比客户区多出阴影边。
    const scale = shown.dpi / 96;
    const frame = await probe.state(shown.hwnd);
    await probe.setBounds(shown.hwnd, {
      width: Math.round(RESIZED.width * scale) + frame.window.width - frame.client.width,
      height: Math.round(RESIZED.height * scale) + frame.window.height - frame.client.height,
    });
    await log.eventually(
      `外框缩放后客户区为 ${RESIZED.width}×${RESIZED.height}`,
      async () => logicalWindowSize((await probe.state(shown.hwnd)).client, shown.dpi),
      (size) => windowSizeMatches(size, RESIZED),
      5_000,
    );
    await log.eventually(
      "WebView 视口跟随宿主窗口",
      () => page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      (size) => windowSizeMatches(size, RESIZED, 1),
      5_000,
    );

    const scroll = page.locator(".atm-main");
    // 先归零：点开过任务抽屉，主区域可能已经被滚过一点，不归零的话不拖也是 >0。
    const metrics = await scroll.evaluate((element) => {
      element.scrollTop = 0;
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
    });
    check(
      "主区域形成可验收的滚动",
      metrics.scrollHeight > metrics.clientHeight,
      JSON.stringify(metrics),
    );
    const box = await scroll.boundingBox();
    check("主滚动区域可见", box !== null);
    await page.bringToFront();
    await scroll.hover({ position: { x: box.width / 2, y: box.height / 2 } });
    await scroll.evaluate((element) => {
      element.tabIndex = -1;
      element.focus();
    });
    const thumbHeight = Math.max(
      48,
      (metrics.clientHeight / metrics.scrollHeight) * metrics.clientHeight,
    );
    const thumbX = box.x + box.width - 5;
    const thumbY = box.y + 8 + thumbHeight / 2;
    await page.mouse.move(thumbX, thumbY);
    await page.mouse.down();
    await page.mouse.move(thumbX, Math.min(box.y + box.height - 40, thumbY + 180), { steps: 8 });
    await page.mouse.up();
    const thumbScrollTop = await log.eventually(
      "拖动滚动条滑块能滚动主区域",
      () => scroll.evaluate((element) => element.scrollTop),
      (value) => value > 0,
      5_000,
    );
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: screenshot });

    // 关窗前停在设置页、窗口是上面改过的尺寸：重开要回到这里（宿主在关窗时记下路由与外框）。
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await log.eventually(
      "关窗前停在设置页",
      () => page.evaluate(() => location.hash),
      (hash) => hash === "#settings",
      5_000,
    );
    const beforeClose = await probe.state(shown.hwnd);

    // 关闭 = 窗口与整个 WebView 一起销毁，core、托盘照常；再点入口重建窗口。
    await page
      .getByTestId("window-close")
      .click({ noWaitAfter: true })
      .catch(() => undefined);
    await log.eventually(
      "关闭按钮销毁窗口（关到托盘）",
      () => appWindow(host),
      (state) => state === null,
      10_000,
    );
    await renderer.browser.close().catch(() => undefined);
    renderer = null;
    check(
      "关到托盘后宿主进程仍在",
      !exited(host.child),
      `pid ${host.pid} exit ${String(host.child.exitCode ?? host.child.signalCode)}`,
    );
    check("关到托盘后服务仍健康", (await readRuntime(host.dataDir)) !== null);
    await requestShow(host);
    const reopened = await visibleWindow(host, "关到托盘后重新打开");
    check("重新打开的是新窗口", reopened.hwnd !== shown.hwnd, String(reopened.hwnd));
    renderer = await connectRenderer(host);
    page = renderer.page;
    await page.waitForSelector(".atm-shell");
    check(
      "重新打开后界面可用",
      (await page.locator(".atm-shell").count()) === 1,
      `CDP 端口 ${renderer.port}`,
    );
    // Electron 关窗是隐藏，页面和窗口状态都还在；原生宿主销毁 WebView，要靠记下的状态复原。
    await log.eventually(
      "重新打开回到关窗前的页面",
      () => page.evaluate(() => location.hash),
      (hash) => hash === "#settings",
      10_000,
    );
    const afterReopen = await probe.state(reopened.hwnd);
    check(
      "重新打开沿用关窗前的尺寸与位置",
      afterReopen.client.width === beforeClose.client.width &&
        afterReopen.client.height === beforeClose.client.height &&
        afterReopen.window.x === beforeClose.window.x &&
        afterReopen.window.y === beforeClose.window.y,
      `${JSON.stringify(beforeClose.window)} → ${JSON.stringify(afterReopen.window)}`,
    );

    // 挪一下再最大化、关窗：重开仍是最大化，还原回到的是这次挪过的外框——宿主要一路记着
    // 最近一次正常外框，不能只在关窗那一刻读（那时已是最大化，读不到），也不能沿用上次关窗记的。
    const moved = await probe.setBounds(reopened.hwnd, {
      x: afterReopen.window.x + 40,
      y: afterReopen.window.y + 30,
      width: afterReopen.window.width,
      height: afterReopen.window.height,
    });
    await page.getByTestId("window-maximize").click();
    await log.eventually(
      "挪过的窗口再最大化",
      async () => (await probe.state(reopened.hwnd)).maximized,
      Boolean,
      5_000,
    );
    await page
      .getByTestId("window-close")
      .click({ noWaitAfter: true })
      .catch(() => undefined);
    await log.eventually(
      "最大化时关到托盘",
      () => appWindow(host),
      (state) => state === null,
      10_000,
    );
    await renderer.browser.close().catch(() => undefined);
    renderer = null;
    await requestShow(host);
    const maximizedReopen = await visibleWindow(host, "最大化关窗后重新打开");
    check(
      "最大化关窗后重新打开仍是最大化",
      (await probe.state(maximizedReopen.hwnd)).maximized,
      JSON.stringify(await probe.state(maximizedReopen.hwnd)),
    );
    renderer = await connectRenderer(host);
    page = renderer.page;
    await page.waitForSelector(".atm-shell");
    await page.getByTestId("window-maximize").click();
    await log.eventually(
      "还原回到最大化之前挪到的外框",
      async () => (await probe.state(maximizedReopen.hwnd)).window,
      (window) =>
        window.x === moved.window.x &&
        window.y === moved.window.y &&
        window.width === moved.window.width &&
        window.height === moved.window.height,
      5_000,
    );

    // 同一件事走系统那条路（系统菜单 / Win+Up）：WM_SYSCOMMAND 最大化，中途再最小化、恢复。
    // 应用按钮会先告诉窗口库「要最大化了」；系统路径不会，移动事件可能先于窗口库更新状态到达。
    const movedAgain = await probe.setBounds(maximizedReopen.hwnd, {
      x: moved.window.x + 30,
      y: moved.window.y + 20,
      width: moved.window.width,
      height: moved.window.height,
    });
    await probe.sysCommand(maximizedReopen.hwnd, "maximize");
    await log.eventually(
      "系统命令最大化",
      async () => (await probe.state(maximizedReopen.hwnd)).maximized,
      Boolean,
      5_000,
    );
    await probe.sysCommand(maximizedReopen.hwnd, "minimize");
    await log.eventually(
      "最大化后再最小化",
      async () => (await probe.state(maximizedReopen.hwnd)).minimized,
      Boolean,
      5_000,
    );
    await probe.sysCommand(maximizedReopen.hwnd, "restore");
    await log.eventually(
      "从最小化恢复回最大化",
      () => probe.state(maximizedReopen.hwnd),
      (state) => state.maximized && !state.minimized,
      5_000,
    );
    await page
      .getByTestId("window-close")
      .click({ noWaitAfter: true })
      .catch(() => undefined);
    await log.eventually(
      "系统最大化后关到托盘",
      () => appWindow(host),
      (state) => state === null,
      10_000,
    );
    await renderer.browser.close().catch(() => undefined);
    renderer = null;
    await requestShow(host);
    const systemReopen = await visibleWindow(host, "系统最大化关窗后重新打开");
    check(
      "系统最大化关窗后重新打开仍是最大化",
      (await probe.state(systemReopen.hwnd)).maximized,
      JSON.stringify(await probe.state(systemReopen.hwnd)),
    );
    await probe.sysCommand(systemReopen.hwnd, "restore");
    await log.eventually(
      "系统还原回到系统最大化之前挪到的外框",
      async () => (await probe.state(systemReopen.hwnd)).window,
      (window) =>
        window.x === movedAgain.window.x &&
        window.y === movedAgain.window.y &&
        window.width === movedAgain.window.width &&
        window.height === movedAgain.window.height,
      5_000,
    );

    return {
      screenshot,
      drawerScreenshot,
      showTimeline: { firstSeen, visibleAtMs: timeline.at(-1)?.atMs },
      initialWindow: { logical: initialLogical, default: DEFAULT_WINDOW_SIZE, dpi: shown.dpi },
      minTrack,
      drawerCollapse: { drawerBox, drawerCollapseBox, drawerLayout, leftOffset },
      notificationMode: storedNotificationMode,
      scrollbar: { ...metrics, thumbScrollTop },
    };
  } catch (error) {
    // 失败时留一张现场截图，定位比读调用栈快。
    await renderer?.page
      .screenshot({ path: join(screenshotDir, "window-smoke-failure.png"), timeout: 5_000 })
      .catch(() => undefined);
    throw error;
  } finally {
    await renderer?.browser.close().catch(() => undefined);
  }
}

const host = startSmokeHost({ executable, dataDir: sandbox.dataDir, env: sandbox.env });
let error: unknown;
let details: Record<string, unknown> = {};
try {
  details = await loginItems.restoreAfter(async () => {
    try {
      return await runSmoke(host);
    } finally {
      const clean = await stopSmokeHost(host);
      log.record("--smoke-quit 干净退出", clean, host.stderr.join(""));
      log.record("退出后运行时文件已清理", !existsSync(runtimeFile(sandbox.dataDir)));
    }
  });
} catch (caught) {
  error = caught;
} finally {
  probe.close();
}
const passed = error === undefined && log.failed.length === 0;
const report = {
  passed,
  executable,
  dataDir: sandbox.dataDir,
  completedAt: new Date().toISOString(),
  ...details,
  checks: log.checks,
  ...(error === undefined
    ? {}
    : { error: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!passed) process.exitCode = 1;
