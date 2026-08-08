import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, request as createRequest, test } from "@playwright/test";

const apiUrl = "http://127.0.0.1:4394/api/v1";
const headers = { authorization: "Bearer e2e-test-token" };

test.beforeAll(async () => {
  mkdirSync(resolve("output", "playwright"), { recursive: true });
  const api = await createRequest.newContext({ extraHTTPHeaders: headers });
  await expect.poll(async () => (await api.get(`${apiUrl}/system/status`)).status()).toBe(200);
  const existing = await api.get(`${apiUrl}/projects`);
  expect(existing.ok()).toBeTruthy();
  const projects = (await existing.json()) as Array<{ code: string }>;
  if (projects.some((project) => project.code === "E2E")) {
    await api.dispose();
    return;
  }
  const project = await api.post(`${apiUrl}/projects`, {
    data: { name: "E2E 验收项目", sourcePath: null, code: "E2E", description: "真实浏览器验收" },
  });
  expect(project.ok()).toBeTruthy();
  const objective = await api.post(`${apiUrl}/projects/E2E/ui/objectives`, {
    data: { opId: "e2e-objective", title: "交付桌面体验", description: "", definitionOfDone: [] },
  });
  const objectiveId = (await objective.json()).id as string;
  const tasks = await api.post(`${apiUrl}/projects/E2E/ui/work-items`, {
    data: {
      opId: "e2e-tasks",
      items: [
        {
          clientRef: "ready",
          objectiveId,
          title: "验证宽屏项目密度",
          status: "READY",
          priority: "HIGH",
          acceptance: [],
          checklist: [],
        },
        {
          clientRef: "focus",
          objectiveId,
          title: "验证键盘与焦点",
          status: "READY",
          priority: "CRITICAL",
          acceptance: [],
          checklist: [],
        },
        {
          clientRef: "search",
          objectiveId,
          title: "验证搜索与保存视图",
          status: "READY",
          priority: "NORMAL",
          acceptance: [],
          checklist: [],
        },
      ],
    },
  });
  expect(tasks.ok()).toBeTruthy();
  await api.dispose();
});

test("1366、1920、3440 桌面密度和项目管理信息均可用", async ({ page }) => {
  const viewports = [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 3440, height: 1440 },
  ];
  for (const [index, viewport] of viewports.entries()) {
    await page.setViewportSize(viewport);
    if (index === 0) await page.goto("/#overview");
    else await page.getByRole("button", { name: "总览", exact: true }).click();
    await expect(page.getByRole("heading", { name: "总览", exact: true })).toBeVisible();
    await expect(page.getByText("进行中项目")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: /E2E 验收项目/u })
      .first()
      .click();
    await expect(page.getByRole("region", { name: "项目管理摘要" })).toBeVisible();
    await expect(page.getByRole("region", { name: "工程统计" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "阻塞 / 等待" })).toBeVisible();
    await page.screenshot({
      path: resolve("output", "playwright", `e2e-project-${viewport.width}.png`),
      fullPage: true,
    });
  }
});

test("任务抽屉、搜索和新建任务具有 Esc、焦点圈定与焦点恢复", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/#project:E2E");
  const task = page.getByRole("button", { name: /验证键盘与焦点/u }).first();
  await task.click();
  const drawer = page.getByRole("dialog", { name: "任务详情" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "关闭" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]")))).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(task).toBeFocused();

  const searchButton = page.getByRole("button", { name: /搜索任务、记录和项目/u });
  await searchButton.click();
  const search = page.getByRole("textbox", { name: "全局搜索" });
  await expect(search).toBeFocused();
  await search.fill("键盘");
  await expect(page.getByRole("button", { name: /验证键盘与焦点/u }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(searchButton).toBeFocused();

  await page.keyboard.press("Control+n");
  const createDialog = page.getByRole("dialog", { name: "新建任务" });
  await expect(createDialog).toBeVisible();
  await expect(page.locator("#task-title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(createDialog).toBeHidden();
});

test("项目视图、全局搜索和保存视图走真实 API", async ({ page }) => {
  await page.goto("/#project:E2E");
  await page.getByRole("button", { name: "看板" }).click();
  await expect(page.getByText("待开始", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "时间线", exact: true }).click();
  await expect(page.getByText(/任务已创建/u).first()).toBeVisible();
  await page.getByRole("button", { name: "记录", exact: true }).click();
  await expect(page.getByText("还没有项目记录")).toBeVisible();
  await page.getByRole("button", { name: "列表" }).click();

  await page.getByLabel("状态筛选").selectOption("READY");
  page.once("dialog", (dialog) => dialog.accept("E2E 可开始"));
  await page.getByRole("button", { name: "保存当前" }).click();
  await expect(page.getByLabel("保存视图").getByRole("option", { name: "E2E 可开始" })).toHaveCount(
    1,
  );

  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "全局搜索" }).fill("保存视图");
  await expect(page.getByRole("button", { name: /验证搜索与保存视图/u }).first()).toBeVisible();
});

test("暗黑主题可手动切换并在 reload 后持久化", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/#overview");

  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", "light");
  const darkToggle = page.getByRole("button", { name: "切换至暗黑模式" });
  await expect(darkToggle).toBeVisible();
  await darkToggle.click();

  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "切换至亮色模式" })).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("atm.theme"))).toBe("dark");

  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "切换至亮色模式" })).toBeVisible();
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-theme-dark.png"),
    fullPage: true,
  });
});
