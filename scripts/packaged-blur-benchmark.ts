/**
 * 毛玻璃性能基准：在原生 smoke 宿主（WebView2）里，三种窗口尺寸下各连续滚动 10 秒，
 * 比较 blur 开/关的帧时间，决定是否保留 backdrop-filter。
 *
 * 窗口尺寸改的是宿主窗口本身（Win32 SetWindowPos，外框 = 视口 × DPI + 阴影边），
 * 不是 CDP 的视口模拟——要测的是真实合成面积下的合成开销。
 *
 *   pnpm benchmark:blur-packaged                 只在 clean Git tree 上运行，报告可作证据
 *   pnpm benchmark:blur-packaged --allow-dirty   探索性运行：报告如实记 gitDirty: true，不作证据
 *
 * 报告写 output/performance/native-blur-benchmark.json；Electron 时代的
 * output/performance/packaged-blur-benchmark.json 是已发布的历史证据，不覆盖。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname, join, relative } from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import { rendererPost } from "./renderer-user-request.js";
import {
  assertBlurBenchmarkReport,
  compareBlurRows,
  summarizeFrameTimes,
  type BlurBenchmarkReport,
  type BlurBenchmarkRow,
} from "./blur-benchmark-report.js";
import { NativeWindowProbe, type NativeWindowState } from "./native-window.js";
import {
  connectRenderer,
  openProjectFromSidebar,
  outputRoot,
  prepareSandbox,
  requestShow,
  smokeExecutable,
  startSmokeHost,
  stopSmokeHost,
  waitForRuntime,
  waitUntil,
  snapshotLoginItems,
  type SmokeRenderer,
} from "./smoke-host.js";

const root = process.cwd();
const executable = smokeExecutable();
const rendererDir = join(dirname(executable), "renderer");
const outputDir = join(outputRoot, "performance");
const screenshotDir = join(outputRoot, "playwright");
const reportPath = join(outputDir, "native-blur-benchmark.json");
const allowDirty = process.argv.includes("--allow-dirty");
const durationMs = 10_000;
const thresholdPercent = 20;
const viewports = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 3440, height: 1440 },
] as const;

const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const gitState = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const gitDirty = gitState.length > 0;
if (gitDirty && !allowDirty)
  throw new Error(
    "packaged blur benchmark 只允许在 clean Git tree 上运行（探索性运行加 --allow-dirty，报告不作证据）",
  );

const sha256File = async (path: string): Promise<string> =>
  new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });

/** renderer 目录的摘要：按相对路径排序，逐个文件「路径 + 内容摘要」再摘要一次。 */
async function sha256Directory(directory: string): Promise<string> {
  const entries = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort((left, right) => relative(directory, left).localeCompare(relative(directory, right)));
  if (entries.length === 0) throw new Error(`renderer 目录是空的：${directory}`);
  const hash = createHash("sha256");
  for (const path of entries)
    hash.update(`${relative(directory, path).replaceAll("\\", "/")}\0${await sha256File(path)}\n`);
  return hash.digest("hex");
}

const [executableSha256, rendererSha256] = await Promise.all([
  sha256File(executable),
  sha256Directory(rendererDir),
]);
const candidateSha256 = createHash("sha256")
  .update(JSON.stringify({ gitHead, gitDirty, executableSha256, rendererSha256 }))
  .digest("hex");

await mkdir(outputDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });
const sandbox = await prepareSandbox("blur-benchmark");
// 先拍 Run 快照，再起探针和宿主：读不到就什么都不启动。
const loginItems = snapshotLoginItems();
const probe = NativeWindowProbe.start();

const scalarMetrics = (metrics: Array<{ name: string; value: number }>) => {
  const values = new Map(metrics.map((metric) => [metric.name, metric.value]));
  const value = (name: string) => values.get(name) ?? 0;
  return {
    frames: value("Frames"),
    layoutCount: value("LayoutCount"),
    layoutDuration: value("LayoutDuration"),
    recalcStyleCount: value("RecalcStyleCount"),
    recalcStyleDuration: value("RecalcStyleDuration"),
    scriptDuration: value("ScriptDuration"),
    taskDuration: value("TaskDuration"),
  };
};

const activityDelta = (
  before: ReturnType<typeof scalarMetrics>,
  after: ReturnType<typeof scalarMetrics>,
): Omit<
  BlurBenchmarkRow["activity"],
  "compositorEventCount" | "gpuEventCount" | "rasterEventCount" | "tracedDurationMs"
> => ({
  frameCount: Math.max(0, Math.round(after.frames - before.frames)),
  layoutCount: Math.max(0, Math.round(after.layoutCount - before.layoutCount)),
  layoutDurationMs: Math.max(0, Math.round((after.layoutDuration - before.layoutDuration) * 1_000)),
  recalcStyleCount: Math.max(0, Math.round(after.recalcStyleCount - before.recalcStyleCount)),
  recalcStyleDurationMs: Math.max(
    0,
    Math.round((after.recalcStyleDuration - before.recalcStyleDuration) * 1_000),
  ),
  scriptDurationMs: Math.max(0, Math.round((after.scriptDuration - before.scriptDuration) * 1_000)),
  taskDurationMs: Math.max(0, Math.round((after.taskDuration - before.taskDuration) * 1_000)),
});

const startTraceActivity = async (cdp: CDPSession) => {
  const activity = {
    compositorEventCount: 0,
    gpuEventCount: 0,
    rasterEventCount: 0,
    tracedDurationMs: 0,
  };
  const onTraceData = (event: { value: Array<{ cat?: string; name?: string; dur?: number }> }) => {
    for (const entry of event.value) {
      const categories = entry.cat ?? "";
      const name = entry.name ?? "";
      if (
        /\b(?:cc|viz|benchmark)\b/u.test(categories) ||
        /Composite|DrawFrame|BeginFrame/u.test(name)
      ) {
        activity.compositorEventCount += 1;
      }
      if (/\b(?:gpu|viz)\b/u.test(categories) || /Gpu/u.test(name)) activity.gpuEventCount += 1;
      if (/Raster|Paint/u.test(name)) activity.rasterEventCount += 1;
      if (typeof entry.dur === "number" && Number.isFinite(entry.dur) && entry.dur > 0) {
        activity.tracedDurationMs += entry.dur / 1_000;
      }
    }
  };
  cdp.on("Tracing.dataCollected", onTraceData);
  await cdp.send("Tracing.start", {
    categories: "cc,gpu,viz,benchmark,disabled-by-default-devtools.timeline.frame",
    transferMode: "ReportEvents",
  });
  return async () => {
    const completed = new Promise<void>((resolveTrace) => {
      cdp.once("Tracing.tracingComplete", () => resolveTrace());
    });
    await cdp.send("Tracing.end");
    await completed;
    cdp.off("Tracing.dataCollected", onTraceData);
    return {
      ...activity,
      tracedDurationMs: Math.round(activity.tracedDurationMs),
    };
  };
};

/**
 * 顶栏的磨砂材质画在 .atm-topbar::before 上（shell.css），顶栏本身是透明的；窗口控件的材质在
 * .atm-window-chrome 本身。开关、读回与 fallback 都对准真正画材质的那两个元素。
 */
const setBlur = async (page: Page, blur: "on" | "off") => {
  await page.evaluate((mode) => {
    document.getElementById("atm-blur-benchmark-override")?.remove();
    if (mode === "off") {
      const style = document.createElement("style");
      style.id = "atm-blur-benchmark-override";
      style.textContent =
        ".atm-topbar::before, .atm-window-chrome { backdrop-filter: none !important; }";
      document.head.append(style);
    }
  }, blur);
  await page.waitForTimeout(300);
};

/**
 * 把宿主窗口的客户区调成 viewport（CSS 像素）。外框比客户区多出阴影/缩放边，按当前差值补上；
 * 窗口挪到显示器左上，让最大的 3440 宽视口也落在屏幕内。
 */
async function resizeClient(
  window: NativeWindowState,
  page: Page,
  viewport: { width: number; height: number },
): Promise<void> {
  const state = await probe.state(window.hwnd);
  const devicePixelRatio = await page.evaluate(() => globalThis.devicePixelRatio);
  const left = state.client.x - state.window.x;
  const top = state.client.y - state.window.y;
  await probe.setBounds(window.hwnd, {
    x: state.monitor.x - left,
    y: state.monitor.y - top,
    width: Math.round(viewport.width * devicePixelRatio) + state.window.width - state.client.width,
    height:
      Math.round(viewport.height * devicePixelRatio) + state.window.height - state.client.height,
  });
  const actual = await waitUntil(
    async () => {
      const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      return size.width === viewport.width && size.height === viewport.height ? size : null;
    },
    10_000,
    `视口 ${viewport.width}x${viewport.height}`,
  );
  if (!actual) throw new Error(`视口没有跟上宿主窗口：${JSON.stringify(viewport)}`);
}

async function measure(renderer: SmokeRenderer, window: NativeWindowState): Promise<void> {
  const page = renderer.page;
  // 搭数据要以用户身份写（/ui/*），daemon.json 的 Agent 凭证会被拒，所以经 renderer 走。
  const post = (path: string, body: unknown): Promise<any> => rendererPost(page, path, body);

  await post("/api/v1/projects", {
    name: "Packaged Blur Performance",
    sourcePath: null,
    code: "BLUR",
    description: "固定 240 任务的 packaged performance fixture",
  });
  const objective = await post("/api/v1/projects/BLUR/ui/objectives", {
    opId: "blur-benchmark-objective",
    title: "验证长列表滚动合成性能",
    description: "",
    definitionOfDone: [],
  });
  for (let batch = 0; batch < 6; batch += 1) {
    await post("/api/v1/projects/BLUR/ui/work-items", {
      opId: `blur-benchmark-tasks-${batch}`,
      items: Array.from({ length: 40 }, (_, index) => {
        const ordinal = batch * 40 + index + 1;
        return {
          clientRef: `blur-${ordinal}`,
          objectiveId: objective.id,
          title: `长列表滚动性能样本 ${String(ordinal).padStart(3, "0")}`,
          description: "固定长度说明用于稳定表格绘制负载",
          status: "READY",
          priority: ordinal % 4 === 0 ? "HIGH" : "NORMAL",
          acceptance: ["保持稳定行高与可读内容"],
          checklist: [],
        };
      }),
    });
  }
  await openProjectFromSidebar(page, "Packaged Blur Performance");
  await waitUntil(
    async () => ((await page.locator(".atm-table tbody tr").count()) === 240 ? true : null),
    20_000,
    "长列表 240 行",
  );
  const scrollRange = await page
    .locator(".atm-main")
    .evaluate((element) => element.scrollHeight - element.clientHeight);
  if (scrollRange < 5_000) throw new Error(`长列表滚动范围不足：${scrollRange}`);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const rows: BlurBenchmarkRow[] = [];
  for (const [viewportIndex, viewport] of viewports.entries()) {
    await resizeClient(window, page, viewport);
    const order: Array<"on" | "off"> = viewportIndex % 2 === 0 ? ["on", "off"] : ["off", "on"];
    for (const blur of order) {
      await setBlur(page, blur);
      const computed = await page.evaluate(() => ({
        topbar: getComputedStyle(document.querySelector(".atm-topbar")!, "::before").backdropFilter,
        window: getComputedStyle(document.querySelector(".atm-window-chrome")!).backdropFilter,
      }));
      if (
        blur === "on" &&
        (!computed.topbar.includes("blur") || !computed.window.includes("blur"))
      ) {
        throw new Error(`blur-on 未命中真实材质：${JSON.stringify(computed)}`);
      }
      if (blur === "off" && (computed.topbar !== "none" || computed.window !== "none")) {
        throw new Error(`blur-off 未关闭真实材质：${JSON.stringify(computed)}`);
      }
      const before = scalarMetrics((await cdp.send("Performance.getMetrics")).metrics);
      const stopTraceActivity = await startTraceActivity(cdp);
      let measurement: { elapsedMs: number; frameTimes: number[] };
      let traceActivity: Awaited<ReturnType<typeof stopTraceActivity>>;
      try {
        measurement = await page.locator(".atm-main").evaluate(async (element, runDurationMs) => {
          element.scrollTop = 0;
          const frameTimes: number[] = [];
          const startedAt = performance.now();
          let previousAt = await new Promise<number>((resolveFrame) =>
            requestAnimationFrame(resolveFrame),
          );
          let direction = 1;
          while (previousAt - startedAt < runDurationMs) {
            const now = await new Promise<number>((resolveFrame) =>
              requestAnimationFrame(resolveFrame),
            );
            const delta = now - previousAt;
            previousAt = now;
            if (delta > 0) frameTimes.push(delta);
            const maxScroll = element.scrollHeight - element.clientHeight;
            element.scrollTop += direction * delta * 0.42;
            if (element.scrollTop >= maxScroll - 1) direction = -1;
            else if (element.scrollTop <= 1) direction = 1;
          }
          return { elapsedMs: previousAt - startedAt, frameTimes };
        }, durationMs);
      } finally {
        traceActivity = await stopTraceActivity();
      }
      const after = scalarMetrics((await cdp.send("Performance.getMetrics")).metrics);
      const rawFrameTimesMs = measurement.frameTimes.map(
        (sample) => Math.round(sample * 1_000) / 1_000,
      );
      rows.push({
        viewport,
        blur,
        measurementDurationMs: Math.round(measurement.elapsedMs * 1_000) / 1_000,
        rawFrameTimesMs,
        computedTopbarFilter: computed.topbar,
        computedWindowFilter: computed.window,
        frames: summarizeFrameTimes(rawFrameTimesMs),
        activity: { ...activityDelta(before, after), ...traceActivity },
      });
      await page.screenshot({
        path: join(screenshotDir, `packaged-blur-${viewport.width}x${viewport.height}-${blur}.png`),
      });
    }
  }

  await setBlur(page, "on");
  await page.emulateMedia({ forcedColors: "active" });
  const forcedColors = await page.evaluate(() => ({
    matched: matchMedia("(forced-colors: active)").matches,
    topbar: getComputedStyle(document.querySelector(".atm-topbar")!, "::before").backdropFilter,
    window: getComputedStyle(document.querySelector(".atm-window-chrome")!).backdropFilter,
    topbarBackground: getComputedStyle(document.querySelector(".atm-topbar")!, "::before")
      .backgroundColor,
    windowBackground: getComputedStyle(document.querySelector(".atm-window-chrome")!)
      .backgroundColor,
  }));
  await page.emulateMedia({ forcedColors: "none" });
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  const reducedTransparency = await page.evaluate(() => ({
    matched: matchMedia("(prefers-reduced-transparency: reduce)").matches,
    topbar: getComputedStyle(document.querySelector(".atm-topbar")!, "::before").backdropFilter,
    window: getComputedStyle(document.querySelector(".atm-window-chrome")!).backdropFilter,
    topbarBackground: getComputedStyle(document.querySelector(".atm-topbar")!, "::before")
      .backgroundColor,
    windowBackground: getComputedStyle(document.querySelector(".atm-window-chrome")!)
      .backgroundColor,
  }));
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  const device = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return {
      devicePixelRatio,
      userAgent: navigator.userAgent,
      webglVendor: debug && gl ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : "unknown",
      webglRenderer:
        debug && gl ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "unknown",
    };
  });
  await cdp.detach();
  const comparisons = compareBlurRows(rows, thresholdPercent);
  const report: BlurBenchmarkReport = {
    schemaVersion: 2,
    host: "webview2",
    generatedAt: new Date().toISOString(),
    durationMs,
    thresholdPercent,
    aggregationMethod:
      "Raw requestAnimationFrame deltas; p50/p95 use linear interpolation; a dropped frame exceeds 1.5x the measured median; visible drop means at least 3 consecutive dropped frames.",
    candidate: {
      gitHead,
      gitDirty,
      executableSha256,
      rendererSha256,
      candidateSha256,
    },
    device: {
      platform: process.platform,
      architecture: process.arch,
      cpuModel: cpus()[0]?.model ?? "unknown",
      logicalCores: cpus().length,
      totalMemoryBytes: totalmem(),
      ...device,
    },
    rows,
    comparisons,
    fallbacks: {
      forcedColorsMatched: forcedColors.matched,
      forcedColorsTopbarFilter: forcedColors.topbar,
      forcedColorsWindowFilter: forcedColors.window,
      forcedColorsTopbarBackground: forcedColors.topbarBackground,
      forcedColorsWindowBackground: forcedColors.windowBackground,
      reducedTransparencyMatched: reducedTransparency.matched,
      reducedTransparencyTopbarFilter: reducedTransparency.topbar,
      reducedTransparencyWindowFilter: reducedTransparency.window,
      reducedTransparencyTopbarBackground: reducedTransparency.topbarBackground,
      reducedTransparencyWindowBackground: reducedTransparency.windowBackground,
    },
    decision: comparisons.some((entry) => entry.thresholdExceeded) ? "DISABLE_BLUR" : "KEEP_BLUR",
  };
  try {
    assertBlurBenchmarkReport(report, { allowDirty });
  } catch (error) {
    // 一轮要测一分多钟：被拒的报告另存一份，量到的数据不丢，但不占用正式报告的位置。
    await writeFile(
      reportPath.replace(/\.json$/u, ".rejected.json"),
      `${JSON.stringify({ rejected: String(error), report }, null, 2)}\n`,
      "utf8",
    );
    throw error;
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ ok: true, report: reportPath, gitDirty, candidateSha256, decision: report.decision, comparisons })}\n`,
  );
}

const host = startSmokeHost({ executable, dataDir: sandbox.dataDir, env: sandbox.env });
try {
  await loginItems.restoreAfter(async () => {
    let renderer: SmokeRenderer | null = null;
    try {
      await waitForRuntime(host);
      await requestShow(host);
      const window = await waitUntil(
        async () => {
          const state = await probe.appWindow(host.pid);
          return state?.visible ? state : null;
        },
        20_000,
        "应用窗口可见",
      );
      renderer = await connectRenderer(host);
      await renderer.page.waitForSelector(".atm-shell");
      await measure(renderer, window);
    } catch (error) {
      // 失败时留一张现场截图。
      await renderer?.page
        .screenshot({ path: join(screenshotDir, "packaged-blur-failure.png"), timeout: 5_000 })
        .catch(() => undefined);
      throw error;
    } finally {
      await renderer?.browser.close().catch(() => undefined);
      if (!(await stopSmokeHost(host)))
        process.stderr.write(`宿主没有按 --smoke-quit 干净退出：${host.stderr.join("")}\n`);
    }
  });
} finally {
  probe.close();
}
