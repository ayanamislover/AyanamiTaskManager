import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, _electron as electron } from "@playwright/test";

const root = process.cwd();
const executable = resolve(
  process.env.ATM_PACKAGED_EXE ??
    join(root, "out", "AyanamiTaskManager-win32-x64", "AyanamiTaskManager.exe"),
);
const dataDir = resolve(join(root, "output", "window-smoke-data"));
const electronUserDataDir = resolve(join(root, "output", "window-smoke-electron-profile"));
const nativeHitTestScript = resolve(join(root, "scripts", "native-window-hittest.ps1"));
const windowsPowerShell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const screenshot = resolve(join(root, "output", "playwright", "packaged-window-polish.png"));
const drawerScreenshot = resolve(
  join(root, "output", "playwright", "packaged-window-drawer-safe-area.png"),
);
if (!existsSync(executable)) throw new Error(`找不到打包应用：${executable}`);
if (!existsSync(nativeHitTestScript))
  throw new Error(`找不到原生命中测试脚本：${nativeHitTestScript}`);
await rm(dataDir, { recursive: true, force: true });
await rm(electronUserDataDir, { recursive: true, force: true });
await mkdir(join(root, "output", "playwright"), { recursive: true });

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
    if (!response.ok) throw new Error(`${path} 创建验收数据失败：${response.status}`);
    return response.json();
  };
  const nativeWindow = await application.browserWindow(page);
  const nativeWindowHandle = await nativeWindow.evaluate((window) => {
    const handle = window.getNativeWindowHandle();
    return handle.length === 8
      ? handle.readBigUInt64LE(0).toString()
      : BigInt(handle.readUInt32LE(0)).toString();
  });
  await expect(page.locator(".atm-brand img")).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "窗口控制" })).toBeVisible();
  await expect
    .poll(() => nativeWindow.evaluate((window) => window.getBounds()))
    .toMatchObject({
      width: 1920,
      height: 1080,
    });
  await expect
    .poll(() =>
      page
        .locator(".atm-nav button")
        .first()
        .evaluate((element) => getComputedStyle(element).userSelect),
    )
    .toBe("none");

  const expectNativeRegion = async (
    selector: string,
    expectedRegion: "drag" | "no-drag",
    expectedHit: 1 | 2,
  ) => {
    const target = page.locator(selector);
    await expect
      .poll(() =>
        target.evaluate((element) =>
          getComputedStyle(element).getPropertyValue("-webkit-app-region"),
        ),
      )
      .toBe(expectedRegion);
    const box = await target.boundingBox();
    if (!box) throw new Error(`原生命中区域不可见：${selector}`);
    const hit = Number(
      execFileSync(
        windowsPowerShell,
        [
          "-NoLogo",
          "-NoProfile",
          "-File",
          nativeHitTestScript,
          "-WindowHandle",
          nativeWindowHandle,
          "-ClientX",
          String(box.x + box.width / 2),
          "-ClientY",
          String(box.y + box.height / 2),
        ],
        { encoding: "utf8" },
      ).trim(),
    );
    expect(hit).toBe(expectedHit);
  };

  await expectNativeRegion('[data-testid="window-drag-brand"]', "drag", 2);
  await expectNativeRegion('[data-testid="window-drag-actions"] > .atm-badge', "drag", 2);

  await page.getByRole("button", { name: /搜索任务、记录和项目/u }).click();
  await expect(page.getByRole("dialog", { name: "全局搜索" })).toBeVisible();
  await page.keyboard.press("Escape");
  const themeBefore = await page.locator("html").getAttribute("data-theme");
  await page.getByRole("button", { name: /切换至.+模式/u }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", themeBefore ?? "");

  await expectNativeRegion('[data-testid="window-minimize"]', "no-drag", 1);
  await expectNativeRegion('[data-testid="window-maximize"]', "no-drag", 1);
  await expectNativeRegion('[data-testid="window-close"]', "no-drag", 1);

  await page.evaluate(() => {
    location.hash = "settings";
    location.reload();
  });
  await page.waitForSelector(".atm-shell");
  const criticalNotifications = page.getByRole("radio", { name: /仅严重事件/u });
  await criticalNotifications.click();
  await expect(criticalNotifications).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存", { exact: true })).toBeVisible();
  const settingsResponse = await fetch(`${runtime.endpoint}/api/v1/settings`, {
    headers: { authorization: `Bearer ${runtime.token}` },
  });
  if (!settingsResponse.ok) throw new Error(`读取打包版通知设置失败：${settingsResponse.status}`);
  const storedSettings = (await settingsResponse.json()) as Array<{
    key: string;
    value: unknown;
  }>;
  const storedNotificationMode = storedSettings.find(
    (setting) => setting.key === "notification.mode",
  )?.value;
  expect(storedNotificationMode).toBe("CRITICAL");

  await post("/api/v1/projects", {
    name: "窗口安全区验收",
    sourcePath: null,
    code: "WIN",
    description: "真实 Electron 抽屉验收",
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
  await page.evaluate(() => {
    location.hash = "project:WIN";
    location.reload();
  });
  await page.waitForSelector(".atm-shell");
  await page
    .getByRole("button", { name: /验证窗口控制安全区/u })
    .first()
    .click();
  const drawer = page.getByRole("dialog", { name: "任务详情" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "验证窗口控制安全区" })).toBeVisible();
  await expect
    .poll(() =>
      drawer.evaluate((element) => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        return Math.abs(matrix.m41) < 0.5;
      }),
    )
    .toBe(true);
  const chromeBox = await page.getByRole("toolbar", { name: "窗口控制" }).boundingBox();
  const drawerCloseBox = await drawer.getByRole("button", { name: "关闭" }).boundingBox();
  if (!chromeBox || !drawerCloseBox) throw new Error("窗口控制或抽屉关闭按钮不可见");
  const drawerLayout = await drawer.locator(".atm-drawer-head").evaluate((element) => ({
    desktop: document.documentElement.dataset.atmDesktop,
    paddingRight: getComputedStyle(element).paddingRight,
    box: element.getBoundingClientRect().toJSON(),
  }));
  const overlaps = !(
    drawerCloseBox.x + drawerCloseBox.width <= chromeBox.x ||
    drawerCloseBox.x >= chromeBox.x + chromeBox.width ||
    drawerCloseBox.y + drawerCloseBox.height <= chromeBox.y ||
    drawerCloseBox.y >= chromeBox.y + chromeBox.height
  );
  await page.screenshot({ path: drawerScreenshot });
  const separation = Math.max(
    chromeBox.x - (drawerCloseBox.x + drawerCloseBox.width),
    drawerCloseBox.x - (chromeBox.x + chromeBox.width),
    chromeBox.y - (drawerCloseBox.y + drawerCloseBox.height),
    drawerCloseBox.y - (chromeBox.y + chromeBox.height),
  );
  if (overlaps || separation < 12) {
    throw new Error(
      `窗口控制与抽屉关闭按钮安全区不足：${JSON.stringify({ chromeBox, drawerCloseBox, drawerLayout, overlaps, separation })}`,
    );
  }
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

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

  await nativeWindow.evaluate((window) => window.setSize(1440, 900));
  await expect
    .poll(() => nativeWindow.evaluate((window) => window.getBounds()))
    .toMatchObject({ width: 1440, height: 900 });

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
  const health = await fetch(`${runtime.endpoint}/api/v1/system/status`, {
    headers: { authorization: `Bearer ${runtime.token}` },
  });
  if (!health.ok) throw new Error(`关闭到托盘后服务不健康：${health.status}`);
  await nativeWindow.evaluate((window) => window.show());
  await expect.poll(() => nativeWindow.evaluate((window) => window.isVisible())).toBe(true);
  process.stdout.write(
    `${JSON.stringify({ ok: true, screenshot, drawerScreenshot, drawerSafeArea: { chromeBox, drawerCloseBox, drawerLayout, separation }, notificationMode: storedNotificationMode, scrollbar: metrics, closeToTray: true })}\n`,
  );
} finally {
  await application.close();
}
