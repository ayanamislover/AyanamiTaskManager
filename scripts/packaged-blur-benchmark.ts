import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { expect, _electron as electron, type Page } from "@playwright/test";
import {
  assertBlurBenchmarkReport,
  compareBlurRows,
  summarizeFrameTimes,
  type BlurBenchmarkReport,
  type BlurBenchmarkRow,
} from "./blur-benchmark-report.js";

const root = process.cwd();
const executable = resolve(
  process.env.ATM_PACKAGED_EXE ??
    join(root, "out", "AyanamiTaskManager-win32-x64", "AyanamiTaskManager.exe"),
);
const asar = join(executable, "..", "resources", "app.asar");
const dataDir = resolve(join(root, "output", "blur-benchmark-data"));
const electronUserDataDir = resolve(join(root, "output", "blur-benchmark-electron-profile"));
const outputDir = resolve(join(root, "output", "performance"));
const screenshotDir = resolve(join(root, "output", "playwright"));
const reportPath = resolve(join(outputDir, "packaged-blur-benchmark.json"));
const durationMs = 10_000;
const thresholdPercent = 20;
const viewports = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 3440, height: 1440 },
] as const;

if (!existsSync(executable) || !existsSync(asar)) {
  throw new Error(`找不到 packaged candidate：${executable}`);
}

const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const gitState = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (gitState) throw new Error("packaged blur benchmark 只允许在 clean Git tree 上运行");

const sha256File = async (path: string): Promise<string> =>
  new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });

const [executableSha256, asarSha256] = await Promise.all([
  sha256File(executable),
  sha256File(asar),
]);
const candidateSha256 = createHash("sha256")
  .update(JSON.stringify({ gitHead, executableSha256, asarSha256 }))
  .digest("hex");

await rm(dataDir, { recursive: true, force: true });
await rm(electronUserDataDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const application = await electron.launch({
  executablePath: executable,
  args: [`--user-data-dir=${electronUserDataDir}`],
  env: {
    ...inheritedEnvironment,
    ATM_DATA_DIR: dataDir,
    ATM_PACKAGED_SMOKE: "1",
  },
});

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
): BlurBenchmarkRow["activity"] => ({
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

const setBlur = async (page: Page, blur: "on" | "off") => {
  await page.evaluate((mode) => {
    document.getElementById("atm-blur-benchmark-override")?.remove();
    if (mode === "off") {
      const style = document.createElement("style");
      style.id = "atm-blur-benchmark-override";
      style.textContent = ".atm-topbar, .atm-window-chrome { backdrop-filter: none !important; }";
      document.head.append(style);
    }
  }, blur);
  await page.waitForTimeout(300);
};

try {
  const page = await application.firstWindow();
  await page.waitForSelector(".atm-shell");
  const runtime = JSON.parse(await readFile(join(dataDir, "runtime", "daemon.json"), "utf8")) as {
    endpoint: string;
    token: string;
  };
  const post = async (path: string, body: unknown): Promise<any> => {
    const response = await fetch(`${runtime.endpoint}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} 创建性能数据失败：${response.status}`);
    return response.json();
  };

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
  for (let batch = 0; batch < 4; batch += 1) {
    await post("/api/v1/projects/BLUR/ui/work-items", {
      opId: `blur-benchmark-tasks-${batch}`,
      items: Array.from({ length: 60 }, (_, index) => {
        const ordinal = batch * 60 + index + 1;
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
  await page.evaluate(() => {
    location.hash = "project:BLUR";
    location.reload();
  });
  await page.waitForSelector(".atm-shell");
  await expect
    .poll(() => page.locator(".atm-table tbody tr").count(), { timeout: 20_000 })
    .toBe(240);
  const scrollRange = await page
    .locator(".atm-main")
    .evaluate((element) => element.scrollHeight - element.clientHeight);
  if (scrollRange < 5_000) throw new Error(`长列表滚动范围不足：${scrollRange}`);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const nativeWindow = await application.browserWindow(page);
  const rows: BlurBenchmarkRow[] = [];
  for (const [viewportIndex, viewport] of viewports.entries()) {
    await nativeWindow.evaluate(
      (window, size) => window.setSize(size.width, size.height),
      viewport,
    );
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toMatchObject({ width: viewport.width, height: viewport.height });
    const order: Array<"on" | "off"> = viewportIndex % 2 === 0 ? ["on", "off"] : ["off", "on"];
    for (const blur of order) {
      await setBlur(page, blur);
      const computed = await page.evaluate(() => ({
        topbar: getComputedStyle(document.querySelector(".atm-topbar")!).backdropFilter,
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
      const samples = await page.locator(".atm-main").evaluate(async (element, runDurationMs) => {
        element.scrollTop = 0;
        const frameTimes: number[] = [];
        await new Promise<void>((resolveRun) => {
          let startedAt = 0;
          let previousAt = 0;
          let direction = 1;
          const step = (now: number) => {
            if (startedAt === 0) {
              startedAt = now;
              previousAt = now;
            } else {
              const delta = now - previousAt;
              previousAt = now;
              if (delta > 0 && delta < 250) frameTimes.push(delta);
              const maxScroll = element.scrollHeight - element.clientHeight;
              element.scrollTop += direction * delta * 0.42;
              if (element.scrollTop >= maxScroll - 1) direction = -1;
              else if (element.scrollTop <= 1) direction = 1;
            }
            if (now - startedAt >= runDurationMs) resolveRun();
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        return frameTimes;
      }, durationMs);
      const after = scalarMetrics((await cdp.send("Performance.getMetrics")).metrics);
      rows.push({
        viewport,
        blur,
        computedTopbarFilter: computed.topbar,
        computedWindowFilter: computed.window,
        frames: summarizeFrameTimes(samples),
        activity: activityDelta(before, after),
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
    topbar: getComputedStyle(document.querySelector(".atm-topbar")!).backdropFilter,
    window: getComputedStyle(document.querySelector(".atm-window-chrome")!).backdropFilter,
  }));
  await page.emulateMedia({ forcedColors: "none" });
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  const reducedTransparency = await page.evaluate(() => ({
    matched: matchMedia("(prefers-reduced-transparency: reduce)").matches,
    topbar: getComputedStyle(document.querySelector(".atm-topbar")!).backdropFilter,
    window: getComputedStyle(document.querySelector(".atm-window-chrome")!).backdropFilter,
  }));
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
  const comparisons = compareBlurRows(rows, thresholdPercent);
  const report: BlurBenchmarkReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    durationMs,
    thresholdPercent,
    candidate: {
      gitHead,
      gitDirty: false,
      executableSha256,
      asarSha256,
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
      reducedTransparencyMatched: reducedTransparency.matched,
      reducedTransparencyTopbarFilter: reducedTransparency.topbar,
      reducedTransparencyWindowFilter: reducedTransparency.window,
    },
    decision: comparisons.some((entry) => entry.thresholdExceeded) ? "DISABLE_BLUR" : "KEEP_BLUR",
  };
  assertBlurBenchmarkReport(report);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ ok: true, report: reportPath, candidateSha256, decision: report.decision, comparisons })}\n`,
  );
} finally {
  await application.close();
}
