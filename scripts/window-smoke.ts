import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, _electron as electron } from "@playwright/test";

const root = process.cwd();
const executable = resolve(
  process.env.ATM_PACKAGED_EXE ??
    join(root, "out", "AyanamiTaskManager-win32-x64", "AyanamiTaskManager.exe"),
);
const dataDir = resolve(join(root, "output", "window-smoke-data"));
const screenshot = resolve(join(root, "output", "playwright", "packaged-window-polish.png"));
if (!existsSync(executable)) throw new Error(`找不到打包应用：${executable}`);
await rm(dataDir, { recursive: true, force: true });
await mkdir(join(root, "output", "playwright"), { recursive: true });

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const application = await electron.launch({
  executablePath: executable,
  env: {
    ...inheritedEnvironment,
    ATM_DATA_DIR: dataDir,
    ATM_PACKAGED_SMOKE: "1",
  },
});

try {
  const page = await application.firstWindow();
  await page.waitForSelector(".atm-shell");
  const nativeWindow = await application.browserWindow(page);
  await expect(page.locator(".atm-brand img")).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "窗口控制" })).toBeVisible();

  const maximize = page.getByTestId("window-maximize");
  await maximize.click();
  await expect.poll(() => nativeWindow.evaluate((window) => window.isMaximized())).toBe(true);
  await maximize.click();
  await expect.poll(() => nativeWindow.evaluate((window) => window.isMaximized())).toBe(false);

  await page.getByTestId("window-minimize").click();
  await expect.poll(() => nativeWindow.evaluate((window) => window.isMinimized())).toBe(true);
  await nativeWindow.evaluate((window) => {
    window.restore();
    window.show();
    window.focus();
  });
  await expect.poll(() => nativeWindow.evaluate((window) => window.isMinimized())).toBe(false);

  const scroll = page.locator(".atm-main");
  const metrics = await scroll.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  if (metrics.scrollHeight <= metrics.clientHeight)
    throw new Error(`主区域没有形成可验收滚动：${JSON.stringify(metrics)}`);
  const box = await scroll.boundingBox();
  if (!box) throw new Error("主滚动区域不可见");
  await page.mouse.click(box.x + box.width - 5, box.y + box.height - 34);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
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
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: screenshot });
  await page.getByTestId("window-close").click();
  await expect.poll(() => nativeWindow.evaluate((window) => window.isVisible())).toBe(false);
  const runtime = JSON.parse(await readFile(join(dataDir, "runtime", "daemon.json"), "utf8")) as {
    endpoint: string;
    token: string;
  };
  const health = await fetch(`${runtime.endpoint}/api/v1/system/status`, {
    headers: { authorization: `Bearer ${runtime.token}` },
  });
  if (!health.ok) throw new Error(`关闭到托盘后服务不健康：${health.status}`);
  await nativeWindow.evaluate((window) => window.show());
  await expect.poll(() => nativeWindow.evaluate((window) => window.isVisible())).toBe(true);
  process.stdout.write(
    `${JSON.stringify({ ok: true, screenshot, scrollbar: metrics, closeToTray: true })}\n`,
  );
} finally {
  await application.close();
}
