import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  expect,
  request as createRequest,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import Database from "better-sqlite3";

const apiUrl = "http://127.0.0.1:4394/api/v1";
const headers = { authorization: "Bearer e2e-test-token" };
const longSidebarProjectName =
  "Codex Agent Permission Preflight And Deployment Readiness Verification";

type ClosingSnapshot = {
  presence: string | null;
  inert: boolean;
  ariaHidden: string | null;
  pointerEvents: string;
  transform: string;
  transitionProperty: string;
  triggerExpanded: string | null;
  triggerFocused: boolean;
};

async function captureClosingState(
  page: Page,
  close: () => Promise<unknown>,
  selector: string,
  options: { inspectSelector?: string; reopenSelector?: string } = {},
): Promise<ClosingSnapshot> {
  const [snapshot] = await Promise.all([
    page.evaluate(
      ({ rootSelector, inspectSelector, reopenSelector }) =>
        new Promise<ClosingSnapshot>((resolveSnapshot, rejectSnapshot) => {
          const timeout = window.setTimeout(() => {
            observer.disconnect();
            rejectSnapshot(new Error(`closing state was not observed for ${rootSelector}`));
          }, 2_500);
          const observe = () => {
            const root = document.querySelector<HTMLElement>(rootSelector);
            if (root?.dataset.presence !== "closing") return;
            const inspected = root.querySelector<HTMLElement>(inspectSelector) ?? root;
            const style = getComputedStyle(inspected);
            const reopen = reopenSelector
              ? document.querySelector<HTMLElement>(reopenSelector)
              : null;
            const result: ClosingSnapshot = {
              presence: root.dataset.presence ?? null,
              inert: root.hasAttribute("inert"),
              ariaHidden: root.getAttribute("aria-hidden"),
              pointerEvents: getComputedStyle(root).pointerEvents,
              transform: style.transform,
              transitionProperty: style.transitionProperty,
              triggerExpanded: reopen?.getAttribute("aria-expanded") ?? null,
              triggerFocused: document.activeElement === reopen,
            };
            reopen?.click();
            window.clearTimeout(timeout);
            observer.disconnect();
            resolveSnapshot(result);
          };
          const observer = new MutationObserver(observe);
          observer.observe(document.documentElement, {
            attributes: true,
            childList: true,
            subtree: true,
            attributeFilter: ["data-presence"],
          });
          observe();
        }),
      {
        rootSelector: selector,
        inspectSelector: options.inspectSelector ?? ":scope",
        reopenSelector: options.reopenSelector ?? null,
      },
    ),
    close(),
  ]);
  return snapshot;
}

async function ensureE2eProjectFixture(api: APIRequestContext): Promise<string[]> {
  const projectsResponse = await api.get(`${apiUrl}/projects`);
  expect(projectsResponse.ok()).toBeTruthy();
  const projects = (await projectsResponse.json()) as Array<{ code: string }>;
  if (!projects.some((project) => project.code === "E2E")) {
    const project = await api.post(`${apiUrl}/projects`, {
      data: {
        name: "E2E 验收项目",
        sourcePath: null,
        code: "E2E",
        description: "真实浏览器验收",
      },
    });
    expect(project.ok()).toBeTruthy();
  }

  const objectivesResponse = await api.get(`${apiUrl}/projects/E2E/objectives`);
  expect(objectivesResponse.ok()).toBeTruthy();
  const objectives = (await objectivesResponse.json()) as Array<{ id: string; title: string }>;
  let objectiveId = objectives.find((objective) => objective.title === "交付桌面体验")?.id;
  if (!objectiveId) {
    const objective = await api.post(`${apiUrl}/projects/E2E/ui/objectives`, {
      data: {
        opId: "e2e-objective-v2",
        title: "交付桌面体验",
        description: "",
        definitionOfDone: [],
      },
    });
    expect(objective.ok()).toBeTruthy();
    objectiveId = ((await objective.json()) as { id: string }).id;
  }

  const expectedTasks = [
    { clientRef: "ready", title: "验证宽屏项目密度", priority: "HIGH" },
    { clientRef: "focus", title: "验证键盘与焦点", priority: "CRITICAL" },
    { clientRef: "search", title: "验证搜索与保存视图", priority: "NORMAL" },
  ] as const;
  const tasksResponse = await api.get(`${apiUrl}/projects/E2E/ui/work-items?limit=100`);
  expect(tasksResponse.ok()).toBeTruthy();
  const taskPage = (await tasksResponse.json()) as {
    items: Array<{ key: string; title: string }>;
  };
  const existingTitles = new Set(taskPage.items.map((task) => task.title));
  const missingTasks = expectedTasks.filter((task) => !existingTitles.has(task.title));
  if (missingTasks.length) {
    const tasks = await api.post(`${apiUrl}/projects/E2E/ui/work-items`, {
      data: {
        opId: `e2e-tasks-${missingTasks.map((task) => task.clientRef).join("-")}-v2`,
        items: missingTasks.map((task) => ({
          ...task,
          objectiveId,
          status: "READY",
          acceptance: [],
          checklist: [],
        })),
      },
    });
    expect(tasks.ok()).toBeTruthy();
  }

  const verifiedResponse = await api.get(`${apiUrl}/projects/E2E/ui/work-items?limit=100`);
  expect(verifiedResponse.ok()).toBeTruthy();
  const verified = (await verifiedResponse.json()) as {
    items: Array<{ key: string; title: string }>;
  };
  return expectedTasks
    .map((expected) => {
      const matches = verified.items.filter((task) => task.title === expected.title);
      expect(matches).toHaveLength(1);
      return matches[0]!.key;
    })
    .sort();
}

test.beforeAll(async () => {
  mkdirSync(resolve("output", "playwright"), { recursive: true });
  const api = await createRequest.newContext({ extraHTTPHeaders: headers });
  await expect
    .poll(
      async () => {
        try {
          return (await api.get(`${apiUrl}/system/status`)).status();
        } catch {
          return 0;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(200);
  const existing = await api.get(`${apiUrl}/projects`);
  expect(existing.ok()).toBeTruthy();
  const projects = (await existing.json()) as Array<{ code: string }>;
  if (!projects.some((project) => project.code === "AGENTPERM")) {
    const longProject = await api.post(`${apiUrl}/projects`, {
      data: {
        name: "Codex Agent Permission Preflight",
        sourcePath: null,
        code: "AGENTPERM",
        description: "侧栏长项目名称布局回归",
      },
    });
    expect(longProject.ok()).toBeTruthy();
  }
  if (!projects.some((project) => project.code === "SIDEBARLONG")) {
    const veryLongProject = await api.post(`${apiUrl}/projects`, {
      data: {
        name: longSidebarProjectName,
        sourcePath: null,
        code: "SIDEBARLONG",
        description: "侧栏两行项目名称截断回归",
      },
    });
    expect(veryLongProject.ok()).toBeTruthy();
  }
  const firstFixture = await ensureE2eProjectFixture(api);
  const replayedFixture = await ensureE2eProjectFixture(api);
  expect(replayedFixture).toEqual(firstFixture);
  await api.dispose();
});

test("长项目名称保持在侧栏项目按钮内", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 768 });
  await page.goto("/#overview");

  const project = page
    .locator(".atm-sidebar")
    .getByRole("button", { name: longSidebarProjectName });
  await expect(project).toHaveAttribute(
    "title",
    `${longSidebarProjectName}\n名称较长，建议改用简洁中文名称。`,
  );
  await expect(project.locator(".atm-nav-project-code")).toHaveCount(0);

  const layout = await project.evaluate((button) => {
    const name = button.querySelector<HTMLElement>(".atm-nav-project-name");
    if (!name) throw new Error("项目导航文本缺失");
    const buttonRect = button.getBoundingClientRect();
    const nameRect = name.getBoundingClientRect();
    const nameStyle = getComputedStyle(name);
    return {
      buttonFits: button.scrollWidth <= button.clientWidth,
      nameFits: nameRect.right <= buttonRect.right,
      nameIsTruncated: name.scrollHeight > name.clientHeight,
      lineClamp: nameStyle.webkitLineClamp,
      lineCount: Math.round(name.clientHeight / Number.parseFloat(nameStyle.lineHeight)),
      overflow: nameStyle.overflow,
      textOverflow: nameStyle.textOverflow,
      whiteSpace: nameStyle.whiteSpace,
    };
  });

  expect(layout).toEqual({
    buttonFits: true,
    nameFits: true,
    nameIsTruncated: true,
    lineClamp: "2",
    lineCount: 2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "normal",
  });
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-sidebar-project-ellipsis.png"),
    fullPage: true,
  });
});

test("总览项目卡长名称最多两行并保留全称提示", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const viewports = [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 3440, height: 1440 },
  ];

  for (const [index, viewport] of viewports.entries()) {
    await page.setViewportSize(viewport);
    if (index === 0) await page.goto("/#overview");
    else await page.getByRole("button", { name: "总览", exact: true }).click();

    const project = page
      .locator(".atm-overview-project")
      .filter({ hasText: longSidebarProjectName })
      .first();
    await expect(project).toHaveCount(1);
    await expect(project).toHaveAttribute(
      "title",
      `${longSidebarProjectName}\n名称较长，建议改用简洁中文名称。`,
    );

    const layout = await project.evaluate((card) => {
      const name = card.querySelector<HTMLElement>(".atm-overview-project-name");
      if (!name) throw new Error("总览项目名称缺失");
      const cardRect = card.getBoundingClientRect();
      const nameRect = name.getBoundingClientRect();
      const nameStyle = getComputedStyle(name);
      const naturalName = name.cloneNode(true) as HTMLElement;
      naturalName.style.display = "block";
      naturalName.style.position = "absolute";
      naturalName.style.visibility = "hidden";
      naturalName.style.width = `${name.clientWidth}px`;
      naturalName.style.height = "auto";
      naturalName.style.maxHeight = "none";
      naturalName.style.overflow = "visible";
      naturalName.style.webkitLineClamp = "unset";
      naturalName.style.setProperty("line-clamp", "unset");
      naturalName.style.margin = "0";
      document.body.append(naturalName);
      const naturalNameHeight = naturalName.getBoundingClientRect().height;
      naturalName.remove();
      const lineHeight = Number.parseFloat(nameStyle.lineHeight);
      return {
        cardFits: card.scrollWidth <= card.clientWidth,
        nameFits: nameRect.right <= cardRect.right,
        nameIsTruncated: naturalNameHeight > lineHeight * 2 + 1,
        lineClamp: nameStyle.webkitLineClamp,
        lineCount: Math.round(nameRect.height / lineHeight),
        naturalLineCount: naturalNameHeight / lineHeight,
        overflow: nameStyle.overflow,
        textOverflow: nameStyle.textOverflow,
        whiteSpace: nameStyle.whiteSpace,
      };
    });

    expect(layout.cardFits).toBe(true);
    expect(layout.nameFits).toBe(true);
    expect(layout.lineClamp).toBe("2");
    expect(layout.lineCount).toBeLessThanOrEqual(2);
    expect(layout.naturalLineCount).toBeGreaterThanOrEqual(layout.lineCount);
    expect(layout.nameIsTruncated).toBe(layout.naturalLineCount > 2 + 1 / 24);
    expect(layout.overflow).toBe("hidden");
    expect(layout.textOverflow).toBe("ellipsis");
    expect(layout.whiteSpace).toBe("normal");
    await page.screenshot({
      path: resolve("output", "playwright", `e2e-overview-project-${viewport.width}-dark.png`),
      fullPage: true,
    });
  }
});

test("侧栏默认精简、工作区可折叠且设置固定在底部", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#overview");

  const sidebar = page.locator(".atm-sidebar");
  const workspace = sidebar.getByRole("button", { name: "工作区", exact: true });
  await expect(sidebar.getByRole("button", { name: "总览", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "项目", exact: true })).toBeVisible();
  await expect(workspace).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.getByRole("button", { name: "Agent", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "设置", exact: true })).toBeVisible();
  await expect(sidebar.getByText("本地优先 · 每项目独立数据库")).toHaveCount(0);

  await workspace.focus();
  await page.keyboard.press("Enter");
  await expect(workspace).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.getByRole("button", { name: "Agent", exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible();
  await page.reload();
  await expect(workspace).toHaveAttribute("aria-expanded", "true");

  await workspace.click();
  await expect(workspace).toHaveAttribute("aria-expanded", "false");
  await sidebar.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "设置", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-sidebar-workspace-collapsed.png"),
    fullPage: true,
  });
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

test("工程统计可点击折叠并用键盘展开", async ({ page }) => {
  let engineeringRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/engineering-metrics")) engineeringRequests += 1;
  });
  await page.goto("/#project:E2E");
  const region = page.getByRole("region", { name: "工程统计" });
  const expand = region.getByRole("button", { name: "展开工程统计" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#engineering-metrics-content")).toBeHidden();
  await page.waitForTimeout(250);
  expect(engineeringRequests).toBe(0);
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-engineering-collapsed.png"),
    fullPage: true,
  });

  await expand.focus();
  await page.keyboard.press("Enter");
  const collapse = region.getByRole("button", { name: "折叠工程统计" });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => engineeringRequests).toBe(1);
  await expect(page.locator("#engineering-metrics-content")).toBeVisible();

  await collapse.click();
  await expect(region.getByRole("button", { name: "展开工程统计" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(engineeringRequests).toBe(1);
});

test("MCP bridge 观测默认折叠、按需读取并使用 30 秒刷新", async ({ page }) => {
  await page.addInitScript(
    ({ endpoint, token }) => {
      const observation = {
        sampledAt: "2026-08-27T03:02:03.000Z",
        metric: "PRIVATE_BYTES" as const,
        totalPrivateBytes: 64 * 1024 * 1024,
        bridges: [
          {
            pid: 4101,
            ownerPid: 101,
            ownerName: "codex",
            startedAt: "2026-08-27T02:00:00.000Z",
            privateBytes: 31 * 1024 * 1024,
          },
          {
            pid: 4102,
            ownerPid: 202,
            ownerName: "claude",
            startedAt: "2026-08-27T02:01:00.000Z",
            privateBytes: 33 * 1024 * 1024,
          },
        ],
      };
      const state = window as typeof window & {
        __mcpBridgeCalls?: number;
        __mcpBridgeIntervals?: number[];
        __runMcpBridgeTimers?: () => void;
      };
      state.__mcpBridgeCalls = 0;
      state.__mcpBridgeIntervals = [];
      const nativeSetInterval = window.setInterval.bind(window);
      const nativeClearInterval = window.clearInterval.bind(window);
      const nativeSetTimeout = window.setTimeout.bind(window);
      const bridgeTimers = new Map<number, () => void>();
      let nextBridgeTimer = 900_000;
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        state.__mcpBridgeIntervals!.push(Number(timeout ?? 0));
        if (timeout === 30_000 && typeof handler === "function") {
          const timer = nextBridgeTimer;
          nextBridgeTimer += 1;
          bridgeTimers.set(timer, () => handler(...args));
          return timer;
        }
        return nativeSetInterval(handler, timeout, ...args);
      }) as typeof window.setInterval;
      window.clearInterval = ((timer?: number) => {
        if (timer !== undefined && bridgeTimers.delete(timer)) return;
        nativeClearInterval(timer);
      }) as typeof window.clearInterval;
      state.__runMcpBridgeTimers = () => {
        for (const tick of bridgeTimers.values()) tick();
      };
      Object.defineProperty(window, "ayanamiDesktop", {
        configurable: true,
        value: {
          runtime: { endpoint, token },
          getMcpBridges: async () => {
            state.__mcpBridgeCalls! += 1;
            await new Promise((resolve) => nativeSetTimeout(resolve, 100));
            return observation;
          },
          minimizeWindow: async () => undefined,
          toggleMaximizeWindow: async () => false,
          isWindowMaximized: async () => false,
          closeWindow: async () => undefined,
          onWindowMaximizedChange: () => () => undefined,
        },
      });
    },
    { endpoint: "http://127.0.0.1:4394", token: "e2e-test-token" },
  );
  await page.goto("/#settings");

  const region = page.getByRole("region", { name: "MCP bridge 观测" });
  const expand = region.getByRole("button", { name: "展开 MCP bridge 观测" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => page.evaluate(() => (window as any).__mcpBridgeCalls as number)).toBe(0);

  await expand.focus();
  await page.keyboard.press("Enter");
  await expect(region.getByRole("button", { name: "折叠 MCP bridge 观测" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect.poll(() => page.evaluate(() => (window as any).__mcpBridgeCalls as number)).toBe(1);
  await page.evaluate(() => (window as any).__runMcpBridgeTimers());
  await page.waitForTimeout(20);
  expect(await page.evaluate(() => (window as any).__mcpBridgeCalls as number)).toBe(1);
  await expect(region.getByText("2 个连接")).toBeVisible();
  await expect(region.getByText("64.00 MiB")).toBeVisible();
  await expect(region.getByText("codex")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__mcpBridgeCalls as number)).toBe(1);
  expect(
    await page.evaluate(() => ((window as any).__mcpBridgeIntervals as number[]).includes(30_000)),
  ).toBe(true);
  await page.evaluate(() => (window as any).__runMcpBridgeTimers());
  await expect.poll(() => page.evaluate(() => (window as any).__mcpBridgeCalls as number)).toBe(2);
  await expect(region.getByRole("button", { name: "刷新观测" })).toBeEnabled();
  await region.getByRole("button", { name: "折叠 MCP bridge 观测" }).click();
  await page.evaluate(() => (window as any).__runMcpBridgeTimers());
  await page.waitForTimeout(20);
  expect(await page.evaluate(() => (window as any).__mcpBridgeCalls as number)).toBe(2);
  await region.getByRole("button", { name: "展开 MCP bridge 观测" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__mcpBridgeCalls as number)).toBe(3);
  await expect(region.getByRole("button", { name: "刷新观测" })).toBeEnabled();
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-mcp-bridge-observation.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "切换至暗黑模式" }).click();
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-mcp-bridge-observation-dark.png"),
    fullPage: true,
  });
});

test("全局与项目时间线展示真实任务、进度和记录语义", async ({ page }) => {
  const api = await createRequest.newContext({ extraHTTPHeaders: headers });
  const suffix = Date.now().toString(36);
  const projectCode = `TL${suffix.toUpperCase()}`;
  const projectName = `时间线语义验收 ${suffix}`;
  const taskTitle = `时间线验收任务 ${suffix}`;
  const progressSummary = `已完成时间线真实事件投影 ${suffix}`;
  const recordTitle = `时间线验收事实 ${suffix}`;
  let sessionId = "";

  const task = async (key: string) => {
    const response = await api.get(`${apiUrl}/projects/${projectCode}/work-items/${key}`);
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as Record<string, any>;
  };
  const patchTask = async (key: string, operation: string, opId: string) => {
    const current = await task(key);
    const response = await api.post(`${apiUrl}/projects/${projectCode}/work-items/patch`, {
      data: {
        session: sessionId,
        opId,
        items: [{ taskKey: key, expectedVersion: current.version, operation }],
      },
    });
    expect(response.ok()).toBeTruthy();
  };

  try {
    const project = await api.post(`${apiUrl}/projects`, {
      data: {
        name: projectName,
        sourcePath: null,
        code: projectCode,
        description: "隔离的真实时间线浏览器验收",
      },
    });
    expect(project.ok()).toBeTruthy();
    const objective = await api.post(`${apiUrl}/projects/${projectCode}/ui/objectives`, {
      data: {
        opId: `e2e-timeline-objective-${suffix}`,
        title: "验证真实事件语义",
        description: "",
        definitionOfDone: [],
      },
    });
    expect(objective.ok()).toBeTruthy();
    const objectiveId = String(((await objective.json()) as Record<string, any>).id);

    const begin = await api.post(`${apiUrl}/sessions`, {
      data: {
        cwd: process.cwd(),
        projectCode,
        mode: "project",
        agentId: `e2e-timeline-${suffix}`,
        displayName: `E2E Timeline ${suffix}`,
        clientKind: "playwright",
        role: "SUBAGENT",
        resume: false,
        allowProjectCreate: false,
      },
    });
    expect(begin.ok()).toBeTruthy();
    sessionId = String((await begin.json()).session);

    const created = await api.post(`${apiUrl}/projects/${projectCode}/work-items`, {
      data: {
        session: sessionId,
        opId: `e2e-timeline-create-${suffix}`,
        items: [
          {
            clientRef: `timeline-${suffix}`,
            objectiveId,
            title: taskTitle,
            description: "验证时间线不再只显示项目摘要已更新",
            type: "TASK",
            priority: "HIGH",
            status: "READY",
            acceptance: ["全局与项目时间线可读"],
            checklist: [],
            verificationRequired: true,
          },
        ],
      },
    });
    expect(created.ok()).toBeTruthy();
    const key = String(((await created.json()) as any).items[0].key);

    await patchTask(key, "claim", `e2e-timeline-claim-${suffix}`);
    await patchTask(key, "start", `e2e-timeline-start-${suffix}`);
    const progress = await api.post(`${apiUrl}/projects/${projectCode}/progress-updates`, {
      data: {
        project: projectCode,
        session: sessionId,
        opId: `e2e-timeline-progress-${suffix}`,
        scope: "task",
        taskKey: key,
        percent: 100,
        summary: progressSummary,
        completed: ["真实事件语义已落库"],
        next: [],
        evidence: [{ kind: "test_result", value: `playwright:timeline:${suffix}` }],
      },
    });
    expect(progress.ok()).toBeTruthy();
    const record = await api.post(`${apiUrl}/projects/${projectCode}/ui/records`, {
      data: {
        opId: `e2e-timeline-record-${suffix}`,
        kind: "FACT",
        title: recordTitle,
        summary: "时间线能够区分记录与任务状态",
        detail: "Playwright 真实服务验收",
        importance: "HIGH",
        scope: "WORK_ITEM",
        workItemKey: key,
      },
    });
    expect(record.ok()).toBeTruthy();
    await patchTask(key, "verify", `e2e-timeline-verify-${suffix}`);
    await patchTask(key, "complete", `e2e-timeline-complete-${suffix}`);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`/#project:${projectCode}`);
    await page.getByRole("tablist").getByRole("tab", { name: "时间线" }).click();
    await expect(page.getByText(progressSummary)).toBeVisible();
    await expect(page.getByText(recordTitle)).toBeVisible();
    await expect(page.getByText("任务进度已更新", { exact: true })).toBeVisible();
    await expect(page.getByText(key, { exact: true }).first()).toBeVisible();
    await page.screenshot({
      path: resolve("output", "playwright", "e2e-project-timeline-readable-dark.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "工作区", exact: true }).click();
    await page.getByRole("button", { name: "全局时间线", exact: true }).click();
    await expect(page.getByText(progressSummary)).toBeVisible();
    await expect(page.getByText(key, { exact: true }).first()).toBeVisible();
    await expect(page.getByText("项目摘要已更新", { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: resolve("output", "playwright", "e2e-global-timeline-readable-dark.png"),
      fullPage: true,
    });
  } finally {
    if (sessionId) {
      const close = await api.post(`${apiUrl}/sessions/${sessionId}/close`, {
        data: {
          project: projectCode,
          opId: `e2e-timeline-close-${suffix}`,
          outcome: "completed",
          summary: "时间线 E2E 清理",
          next: [],
          releaseClaims: true,
        },
      });
      expect(close.ok()).toBeTruthy();
    }
    await api.dispose();
  }
});

test("任务抽屉、搜索和新建任务具有 Esc、焦点圈定与焦点恢复", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/#project:E2E");
  await page.locator("html").evaluate((root) => {
    root.dataset.atmDesktop = "true";
  });
  const task = page.getByRole("button", { name: /验证键盘与焦点/u }).first();
  await task.click();
  const drawer = page.getByRole("dialog", { name: "任务详情" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "关闭", exact: true })).toHaveCount(0);
  const drawerCollapse = drawer.getByRole("button", { name: "收起任务详情" });
  await expect(drawerCollapse).toBeFocused();
  const collapseLayout = await drawerCollapse.evaluate((button) => {
    const drawer = button.closest<HTMLElement>(".atm-drawer");
    if (!drawer) throw new Error("任务抽屉缺失");
    const buttonBox = button.getBoundingClientRect();
    const drawerBox = drawer.getBoundingClientRect();
    return {
      atLeftEdge: buttonBox.left <= drawerBox.left + 1,
      insideDrawer: buttonBox.right <= drawerBox.right,
      width: buttonBox.width,
      height: buttonBox.height,
    };
  });
  expect(collapseLayout.atLeftEdge).toBe(true);
  expect(collapseLayout.insideDrawer).toBe(true);
  expect(collapseLayout.width).toBeGreaterThanOrEqual(44);
  expect(collapseLayout.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-drawer-left-collapse.png"),
    fullPage: true,
  });
  const reservedWindowControlsWidth = await drawer
    .locator(".atm-drawer-head")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingRight));
  expect(reservedWindowControlsWidth).toBeGreaterThanOrEqual(158);
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

test("transient surfaces 可退出和快速反转，command palette 保持即时卸载", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/#project:E2E");

  const task = page.getByRole("button", { name: /验证键盘与焦点/u }).first();
  await task.evaluate((element) => element.setAttribute("data-e2e-presence-trigger", "task"));
  await task.click();
  const drawerBackdrop = page.locator(".atm-drawer-backdrop");
  const drawer = page.getByRole("dialog", { name: "任务详情" });
  await expect(drawerBackdrop).toHaveAttribute("data-presence", "open");
  const drawerClosing = await captureClosingState(
    page,
    () => page.keyboard.press("Escape"),
    ".atm-drawer-backdrop",
    { reopenSelector: '[data-e2e-presence-trigger="task"]' },
  );
  expect(drawerClosing).toMatchObject({
    presence: "closing",
    inert: true,
    ariaHidden: "true",
    pointerEvents: "none",
    triggerFocused: true,
  });
  await expect(drawerBackdrop).toHaveAttribute("data-presence", "open");
  await page.waitForTimeout(360);
  await expect(drawer).toBeVisible();
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-presence-drawer-reopened-dark.png"),
    fullPage: true,
  });
  const finalDrawerClosing = await captureClosingState(
    page,
    () => page.keyboard.press("Escape"),
    ".atm-drawer-backdrop",
  );
  expect(finalDrawerClosing.presence).toBe("closing");
  await expect(drawerBackdrop).toHaveCount(0);
  await expect(task).toBeFocused();

  const createTask = page.getByRole("button", { name: "新建任务", exact: true });
  await createTask.evaluate((element) =>
    element.setAttribute("data-e2e-presence-trigger", "create-task"),
  );
  await createTask.click();
  const modal = page.getByRole("dialog", { name: "新建任务" });
  const modalBackdrop = page
    .locator(".atm-modal-backdrop")
    .filter({ has: page.locator("#create-task-title") });
  const priority = page.getByRole("combobox", { name: "优先级" });
  await priority.evaluate((element) =>
    element.setAttribute("data-e2e-presence-trigger", "priority"),
  );
  await priority.click();
  await expect(page.getByRole("listbox", { name: "优先级" })).toBeVisible();
  const listbox = modal.locator(".atm-select-popover");
  await expect(listbox).toHaveAttribute("data-presence", "open");
  const listboxClosing = await captureClosingState(
    page,
    () => page.keyboard.press("Escape"),
    ".atm-select-popover",
  );
  expect(listboxClosing).toMatchObject({
    presence: "closing",
    inert: true,
    ariaHidden: "true",
  });
  await expect(priority).toBeFocused();
  await expect(modal).toBeVisible();
  await expect(listbox).toHaveCount(0);
  await priority.click();
  await expect(listbox).toHaveAttribute("data-presence", "open");
  const reversingListboxClosing = await captureClosingState(
    page,
    () => priority.click(),
    ".atm-select-popover",
    { reopenSelector: '[data-e2e-presence-trigger="priority"]' },
  );
  expect(reversingListboxClosing).toMatchObject({
    presence: "closing",
    inert: true,
    ariaHidden: "true",
    triggerExpanded: "false",
    triggerFocused: true,
  });
  await expect(priority).toHaveAttribute("aria-expanded", "true");
  await expect(listbox).toHaveAttribute("data-presence", "open");
  await page.waitForTimeout(280);
  await expect(listbox).toHaveCount(1);
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-presence-select-reopened-dark.png"),
    fullPage: true,
  });
  await priority.click();
  await expect(listbox).toHaveCount(0);

  const modalClosing = await captureClosingState(
    page,
    () => modal.getByRole("button", { name: "取消" }).click(),
    ".atm-modal-backdrop",
    { reopenSelector: '[data-e2e-presence-trigger="create-task"]' },
  );
  expect(modalClosing).toMatchObject({
    presence: "closing",
    inert: true,
    ariaHidden: "true",
    triggerFocused: true,
  });
  await expect(modalBackdrop).toHaveAttribute("data-presence", "open");
  await page.waitForTimeout(360);
  await expect(modal).toBeVisible();
  const finalModalClosing = await captureClosingState(
    page,
    () => page.keyboard.press("Escape"),
    ".atm-modal-backdrop",
  );
  expect(finalModalClosing.presence).toBe("closing");
  await expect(modalBackdrop).toHaveCount(0);
  await expect(createTask).toBeFocused();

  const notify = page.getByRole("button", { name: "启动 Agent 会话" });
  await notify.click();
  const notice = page.locator(".atm-notice");
  await expect(notice).toHaveAttribute("data-presence", "open");
  await page.waitForFunction(
    () => document.querySelector(".atm-notice")?.getAttribute("data-presence") === "closing",
    undefined,
    { timeout: 3_500, polling: 25 },
  );
  await notify.click();
  await expect(notice).toHaveAttribute("data-presence", "open");
  await page.waitForTimeout(360);
  await expect(notice).toBeVisible();
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-presence-notice-reopened-dark.png"),
    fullPage: true,
  });

  const searchButton = page.getByRole("button", { name: /搜索任务、记录和项目/u });
  await searchButton.click();
  const command = page.locator(".atm-command");
  await expect(command).toBeVisible();
  expect(await command.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
    "0s",
  );
  await page.keyboard.press("Escape");
  expect(await command.count()).toBe(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await createTask.click();
  await expect(page.getByRole("dialog", { name: "新建任务" })).toBeVisible();
  const reducedBackdrop = page
    .locator(".atm-modal-backdrop")
    .filter({ has: page.locator("#create-task-title") });
  const reducedPriority = page.getByRole("combobox", { name: "优先级" });
  await reducedPriority.click();
  const reducedSelect = reducedBackdrop.locator(".atm-select");
  const reducedPopover = reducedBackdrop.locator(".atm-select-popover");
  await reducedSelect.evaluate((element) => {
    element.dataset.placement = "top";
  });
  const reducedPopoverClosing = await captureClosingState(
    page,
    () => reducedPriority.click(),
    ".atm-select-popover",
  );
  expect(reducedPopoverClosing).toMatchObject({
    presence: "closing",
    ariaHidden: "true",
    transform: "none",
  });
  await expect(reducedPopover).toHaveCount(0);
  const reducedBackdropClosing = await captureClosingState(
    page,
    () => page.keyboard.press("Escape"),
    ".atm-modal-backdrop",
    { inspectSelector: ".atm-modal" },
  );
  expect(reducedBackdropClosing).toMatchObject({
    presence: "closing",
    ariaHidden: "true",
    transform: "none",
    transitionProperty: "opacity",
  });
  await expect(reducedBackdrop).toHaveCount(0);
});

test("forced-colors 与 reduced-transparency 保留焦点并关闭透明材质", async ({ context, page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/#project:E2E");
  expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);

  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "新建任务" });
  const priority = page.getByRole("combobox", { name: "优先级" });
  await priority.click();
  await page.keyboard.press("Escape");
  await expect(modal).toBeVisible();
  await expect(page.getByRole("listbox", { name: "优先级" })).toHaveCount(0);
  await expect(priority).toBeFocused();
  const focusStyle = await priority.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.outlineColor,
      style: style.outlineStyle,
      width: style.outlineWidth,
    };
  });
  expect(focusStyle.style).toBe("solid");
  expect(focusStyle.width).toBe("2px");
  expect(focusStyle.color).not.toBe("rgba(0, 0, 0, 0)");
  expect(
    await page
      .locator(".atm-modal-backdrop")
      .evaluate((element) => getComputedStyle(element).backdropFilter),
  ).toBe("none");
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-forced-colors-focus.png"),
    fullPage: true,
  });

  await page.keyboard.press("Escape");
  await page.emulateMedia({ forcedColors: "none" });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  expect(
    await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches),
  ).toBe(true);
  for (const selector of [".atm-sidebar", ".atm-topbar"]) {
    expect(
      await page.locator(selector).evaluate((element) => getComputedStyle(element).backdropFilter),
    ).toBe("none");
  }
});

test("两张任务表格行与项目 tabs 可完整键盘操作并恢复焦点", async ({ page }) => {
  const api = await createRequest.newContext({ extraHTTPHeaders: headers });
  const suffix = Date.now().toString(36);
  const title = `表格键盘验收 ${suffix}`;
  let sessionId = "";
  try {
    const objectivesResponse = await api.get(`${apiUrl}/projects/E2E/objectives`);
    expect(objectivesResponse.ok()).toBeTruthy();
    const objectives = (await objectivesResponse.json()) as Array<{ id: string }>;
    expect(objectives.length).toBeGreaterThan(0);

    const begin = await api.post(`${apiUrl}/sessions`, {
      data: {
        cwd: process.cwd(),
        projectCode: "E2E",
        mode: "project",
        agentId: `e2e-table-keyboard-${suffix}`,
        displayName: `E2E Table Keyboard ${suffix}`,
        clientKind: "playwright",
        role: "SUBAGENT",
        resume: false,
        allowProjectCreate: false,
      },
    });
    expect(begin.ok()).toBeTruthy();
    sessionId = String((await begin.json()).session);

    const created = await api.post(`${apiUrl}/projects/E2E/work-items`, {
      data: {
        session: sessionId,
        opId: `e2e-table-keyboard-create-${suffix}`,
        items: [
          {
            clientRef: `table-keyboard-${suffix}`,
            objectiveId: objectives[0]!.id,
            title,
            description: "验证项目与跨项目任务表格键盘入口",
            type: "TASK",
            priority: "NORMAL",
            status: "READY",
            acceptance: ["Enter 与 Space 可打开，Escape 恢复焦点"],
            checklist: [],
            verificationRequired: false,
          },
        ],
      },
    });
    expect(created.ok()).toBeTruthy();
    const taskKey = String(((await created.json()) as any).items[0].key);
    const patchTask = async (operation: "claim" | "start") => {
      const currentResponse = await api.get(`${apiUrl}/projects/E2E/work-items/${taskKey}`);
      expect(currentResponse.ok()).toBeTruthy();
      const current = (await currentResponse.json()) as { version: number };
      const response = await api.post(`${apiUrl}/projects/E2E/work-items/patch`, {
        data: {
          session: sessionId,
          opId: `e2e-table-keyboard-${operation}-${suffix}`,
          items: [{ taskKey, expectedVersion: current.version, operation }],
        },
      });
      expect(response.ok()).toBeTruthy();
    };
    await patchTask("claim");
    await patchTask("start");

    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/#project:E2E");
    const tabs = page.getByRole("tablist", { name: "项目任务视图" });
    for (const tab of await tabs.getByRole("tab").all()) {
      await expect(tab).toHaveAttribute("aria-controls", "project-task-panel");
    }
    const listTab = tabs.getByRole("tab", { name: "列表" });
    await expect(listTab).toHaveAttribute("tabindex", "0");
    await listTab.focus();
    await page.keyboard.press("ArrowRight");
    const boardTab = tabs.getByRole("tab", { name: "看板" });
    await expect(boardTab).toBeFocused();
    await expect(boardTab).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    const recordsTab = tabs.getByRole("tab", { name: "记录" });
    await expect(recordsTab).toBeFocused();
    await page.keyboard.press("Home");
    await expect(listTab).toBeFocused();
    await expect(page.getByRole("tabpanel")).toHaveAttribute("id", "project-task-panel");
    await expect(page.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      "project-task-tab-list",
    );

    const projectRow = page.getByRole("row", { name: new RegExp(`打开任务 ${taskKey}`) });
    await projectRow.focus();
    await page.keyboard.press(" ");
    const projectDrawer = page.getByRole("dialog", { name: "任务详情" });
    await expect(projectDrawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(projectDrawer).toBeHidden();
    await expect(projectRow).toBeFocused();

    await page.getByRole("button", { name: "工作区", exact: true }).click();
    await page.getByRole("button", { name: "活动任务", exact: true }).click();
    const globalRow = page.getByRole("row", { name: new RegExp(`打开任务 ${taskKey}`) });
    await globalRow.focus();
    await page.keyboard.press("Enter");
    const globalDrawer = page.getByRole("dialog", { name: "任务详情" });
    await expect(globalDrawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(globalDrawer).toBeHidden();
    await expect(globalRow).toBeFocused();
    await page.screenshot({
      path: resolve("output", "playwright", "e2e-task-table-keyboard-dark.png"),
      fullPage: true,
    });
  } finally {
    if (sessionId) {
      const close = await api.post(`${apiUrl}/sessions/${sessionId}/close`, {
        data: {
          project: "E2E",
          opId: `e2e-table-keyboard-close-${suffix}`,
          outcome: "completed",
          summary: "任务表格键盘 E2E 清理",
          next: [],
          releaseClaims: true,
        },
      });
      expect(close.ok()).toBeTruthy();
    }
    await api.dispose();
  }
});

test("四类项目 Modal 保持自绘控件、焦点恢复与数据工具入口", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/#project:E2E");

  const createTask = page.getByRole("button", { name: "新建任务", exact: true });
  await createTask.click();
  const taskDialog = page.getByRole("dialog", { name: "新建任务" });
  await expect(taskDialog).toBeVisible();
  await expect(taskDialog.locator("#task-title")).toBeFocused();
  await expect(taskDialog.locator("select")).toHaveCount(0);
  const priority = taskDialog.getByRole("combobox", { name: "优先级" });
  await priority.click();
  await expect(page.getByRole("option", { name: "普通", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "低", exact: true }).click();
  await expect(priority).toContainText("低");
  await page.keyboard.press("Escape");
  await expect(taskDialog).toBeHidden();
  await expect(createTask).toBeFocused();

  await page.getByRole("tab", { name: "记录", exact: true }).click();
  const createRecord = page.getByRole("button", { name: "新建记录", exact: true });
  await createRecord.click();
  const recordDialog = page.getByRole("dialog", { name: "新建项目记录" });
  await expect(recordDialog).toBeVisible();
  await expect(recordDialog.locator("#record-title")).toBeFocused();
  await expect(recordDialog.locator("select")).toHaveCount(0);
  const recordKind = recordDialog.getByRole("combobox", { name: "记录类型" });
  await recordKind.click();
  await expect(page.getByRole("option", { name: "决策", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "约束", exact: true }).click();
  await expect(recordKind).toContainText("约束");
  await page.keyboard.press("Escape");
  await expect(recordDialog).toBeHidden();
  await expect(createRecord).toBeFocused();

  const openUpdate = page.getByRole("button", { name: "发布项目更新", exact: true });
  await openUpdate.click();
  const updateDialog = page.getByRole("dialog", { name: "发布项目更新" });
  await expect(updateDialog).toBeVisible();
  await expect(updateDialog.getByRole("button", { name: "关闭" })).toBeFocused();
  await expect(updateDialog.getByText("生成确定性草稿", { exact: true })).toBeVisible();
  await expect(updateDialog.getByRole("button", { name: "生成更新草稿" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(updateDialog).toBeHidden();
  await expect(openUpdate).toBeFocused();

  const openData = page.getByRole("button", { name: "数据工具", exact: true });
  await openData.click();
  const dataDialog = page.getByRole("dialog", { name: "备份、恢复与数据交换" });
  await expect(dataDialog).toBeVisible();
  await expect(dataDialog.getByRole("button", { name: "关闭" }).first()).toBeFocused();
  await expect(dataDialog.getByRole("button", { name: "立即备份" })).toBeVisible();
  await expect(dataDialog.getByRole("button", { name: "导出 .aytproj" })).toBeVisible();
  await expect(dataDialog.getByRole("button", { name: "导出 JSON" })).toBeVisible();
  await expect(dataDialog.getByRole("button", { name: "导出 CSV" })).toBeVisible();
  await expect(dataDialog.locator('input[type="file"][accept*=".md"]')).toBeVisible();
  await expect(dataDialog.getByRole("button", { name: "生成预览" })).toBeDisabled();
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-project-data-modal-dark.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(dataDialog).toBeHidden();
  await expect(openData).toBeFocused();
});

test("Agent 页按身份聚合重复 Session 并保留历史数量", async ({ page }) => {
  const api = await createRequest.newContext({ extraHTTPHeaders: headers });
  const suffix = Date.now().toString(36);
  const agentId = `e2e-dedupe-${suffix}`;
  const displayName = `E2E Duplicate Agent ${suffix}`;
  const begin = async () => {
    const response = await api.post(`${apiUrl}/sessions`, {
      data: {
        cwd: process.cwd(),
        projectCode: "E2E",
        mode: "project",
        agentId,
        displayName,
        clientKind: "playwright",
        role: "PRIMARY",
        resume: false,
        allowProjectCreate: false,
      },
    });
    expect(response.ok()).toBeTruthy();
    return String((await response.json()).session);
  };
  const close = async (sessionId: string) => {
    const response = await api.post(`${apiUrl}/sessions/${sessionId}/close`, {
      data: {
        project: "E2E",
        opId: `e2e-close-${crypto.randomUUID()}`,
        outcome: "completed",
        summary: "Agent 聚合 E2E 清理",
        next: [],
        releaseClaims: true,
      },
    });
    expect(response.ok()).toBeTruthy();
  };

  const closedSession = await begin();
  await close(closedSession);
  const onlineSession = await begin();
  try {
    await page.goto("/#agents");
    const project = page.locator(".agent-project-group").filter({
      has: page.locator(".agent-project-title").getByText("E2E", { exact: true }),
    });
    const card = project.locator(".agent-session-card").filter({ hasText: displayName });
    await expect(project).toHaveCount(1);
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("2 个 Session");
    await card.getByText(/详细上下文与历史/u).click();
    await expect(card.getByLabel("历史 Session")).toContainText(closedSession);
    await expect(card.getByLabel("历史 Session")).toContainText(onlineSession);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: resolve("output", "playwright", "e2e-agent-deduplicated.png"),
      fullPage: true,
    });
  } finally {
    await close(onlineSession);
    await api.dispose();
  }
});

test("Agent Git context、冲突警告、刷新与项目执行 Session 可读", async ({ page }) => {
  const api = await createRequest.newContext({ extraHTTPHeaders: headers });
  const suffix = Date.now().toString(36);
  const sessions: string[] = [];
  const begin = async (label: string) => {
    const response = await api.post(`${apiUrl}/sessions`, {
      data: {
        cwd: process.cwd(),
        projectCode: "E2E",
        mode: "project",
        agentId: `e2e-git-context-${label}-${suffix}`,
        displayName: `E2E Git Context ${label} ${suffix}`,
        clientKind: "playwright",
        role: "SUBAGENT",
        resume: false,
        allowProjectCreate: false,
      },
    });
    expect(response.ok()).toBeTruthy();
    const sessionId = String((await response.json()).session);
    sessions.push(sessionId);
    return sessionId;
  };
  const close = async (sessionId: string) => {
    const response = await api.post(`${apiUrl}/sessions/${sessionId}/close`, {
      data: {
        project: "E2E",
        opId: `e2e-git-context-close-${crypto.randomUUID()}`,
        outcome: "completed",
        summary: "Git Context E2E 清理",
        next: [],
        releaseClaims: true,
      },
    });
    expect(response.ok()).toBeTruthy();
  };

  const primarySession = await begin("primary");
  await begin("conflict");
  const listedTasks = await api.get(`${apiUrl}/projects/E2E/ui/work-items?limit=100`);
  expect(listedTasks.ok()).toBeTruthy();
  const taskList = ((await listedTasks.json()) as { items: Array<Record<string, any>> }).items;
  const task = taskList.find((item) => item.title === "验证键盘与焦点");
  expect(task).toBeTruthy();
  const claim = await api.post(`${apiUrl}/projects/E2E/work-items/patch`, {
    data: {
      session: primarySession,
      opId: `e2e-git-context-claim-${suffix}`,
      items: [
        {
          taskKey: task.key,
          expectedVersion: task.version,
          operation: "claim",
        },
      ],
    },
  });
  expect(claim.ok()).toBeTruthy();

  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/#agents");
    const project = page.locator(".agent-project-group").filter({
      has: page.locator(".agent-project-title").getByText("E2E", { exact: true }),
    });
    const primary = project
      .locator(".agent-session-card")
      .filter({ hasText: `E2E Git Context primary ${suffix}` });
    await expect(primary).toHaveCount(1);
    await expect(primary).toContainText(task.key);
    await expect(primary).toContainText("子 Agent");
    await expect(primary).toContainText("在线");

    const agents = await api.get(`${apiUrl}/projects/E2E/agents`);
    expect(agents.ok()).toBeTruthy();
    const agentPage = (await agents.json()) as { items: Array<Record<string, any>> };
    const agentRows = agentPage.items;
    const primaryAgent = agentRows.find((agent) => agent.id === primarySession);
    expect(primaryAgent).toBeTruthy();
    const primaryGit = primaryAgent.git as Record<string, any>;
    expect(String(primaryGit.branch || "")).not.toBe("");
    expect(String(primaryGit.worktreeRoot || "")).not.toBe("");
    expect(String(primaryGit.head || "")).not.toBe("");
    await expect(primary).toContainText(String(primaryGit.branch));
    await expect(primary).toContainText(String(primaryGit.worktreeRoot).split("\\").pop()!);

    await primary.getByText(/详细上下文与历史/u).click();
    await expect(primary).toContainText("工作目录");
    await expect(primary).toContainText("HEAD");
    await expect(primary).toContainText("持续时间");
    await expect(primary).toContainText(/clean|dirty|未观察/u);

    const warning = page.locator('.atm-notice[role="status"]');
    await expect(warning).toContainText("同一 Worktree");
    await expect(warning).toContainText("同一 Git branch");

    const refreshResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/projects/E2E/sessions/${primarySession}/git-context/refresh`) &&
        response.request().method() === "POST" &&
        response.ok(),
    );
    await primary.getByRole("button", { name: "刷新 Git" }).click();
    await refreshResponse;
    await page.screenshot({
      path: resolve("output", "playwright", "e2e-agent-git-context-dark.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "E2E 验收项目", exact: true }).click();
    const projectAgents = page
      .locator(".atm-panel")
      .filter({ has: page.getByRole("heading", { name: "Agent 与领取" }) });
    await expect(projectAgents).toContainText(`E2E Git Context primary ${suffix}`);
    await expect(projectAgents).toContainText(task.key);

    await page
      .getByRole("button", { name: /验证键盘与焦点/u })
      .first()
      .click();
    const drawer = page.getByRole("dialog", { name: "任务详情" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("heading", { name: "执行 Session" })).toBeVisible();
    await expect(drawer).toContainText(`E2E Git Context primary ${suffix}`);
    await expect(drawer).toContainText(String(primaryGit.branch));
    await expect(drawer).toContainText("Worktree");
    await expect(drawer).toContainText("HEAD");
    await page.screenshot({
      path: resolve("output", "playwright", "e2e-task-drawer-execution-session-dark.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  } finally {
    for (const sessionId of sessions) await close(sessionId);
    await api.dispose();
  }
});

test("设置页展示 Agent 规则与 Skill 状态并可预览 managed block", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(
    ({ endpoint, token }) => {
      const installed = { state: "INSTALLED", version: 1 };
      (window as any).ayanamiDesktop = {
        runtime: { endpoint, token },
        getAgentIntegrations: async () => [
          {
            client: "CODEX",
            mcpInstalled: true,
            sharesRuleAndSkillsWith: null,
            cliAvailable: true,
            rule: { ...installed, path: "C:\\Users\\tester\\.codex\\AGENTS.md" },
            skills: {
              state: "INSTALLED",
              skills: [
                { name: "atm-plan", ...installed },
                { name: "atm-task", ...installed },
              ],
            },
          },
          {
            client: "CLAUDE",
            mcpInstalled: true,
            sharesRuleAndSkillsWith: null,
            cliAvailable: true,
            rule: { ...installed, path: "C:\\Users\\tester\\.claude\\CLAUDE.md" },
            skills: {
              state: "INSTALLED",
              skills: [
                { name: "atm-plan", ...installed },
                { name: "atm-task", ...installed },
              ],
            },
          },
          {
            client: "CLAUDE_CODE",
            mcpInstalled: false,
            sharesRuleAndSkillsWith: "CLAUDE",
            cliAvailable: false,
            rule: { ...installed, path: "C:\\Users\\tester\\.claude\\CLAUDE.md" },
            skills: {
              state: "INSTALLED",
              skills: [
                { name: "atm-plan", ...installed },
                { name: "atm-task", ...installed },
              ],
            },
          },
        ],
        manageAgentIntegration: async (client: string) => ({
          report: null,
          preview: {
            current: "Personal rule.",
            proposed: `<!-- AYANAMI_TASK_MANAGER:BEGIN -->\n## ${client}\n<!-- AYANAMI_TASK_MANAGER:END -->`,
          },
        }),
        getMcpConfigs: async () => ({
          streamableHttp: "{}",
          stdio: "{}",
          generic: "{}",
          agentRule: "ATM",
        }),
        getAutoLaunch: async () => false,
        setAutoLaunch: async () => false,
        getUpdateStatus: async () => ({
          phase: "VERIFY",
          outcome: "ERROR",
          code: "VERIFY_FAILED",
          message: "package checksum mismatch",
          action: "更新包校验失败，请重新生成并投递完整安装包。",
          at: "2026-08-26T12:00:00.000Z",
          version: null,
        }),
        checkForUpdates: async () => ({
          phase: "CHECK",
          outcome: "IN_PROGRESS",
          code: "CHECKING",
          message: "正在检查本地更新",
          action: "正在检查本地更新。",
          at: "2026-08-26T12:01:00.000Z",
          version: null,
        }),
        copyText: async () => true,
        showItemInFolder: async () => undefined,
        minimizeWindow: async () => undefined,
        toggleMaximizeWindow: async () => false,
        isWindowMaximized: async () => false,
        closeWindow: async () => undefined,
        onWindowMaximizedChange: () => () => undefined,
        onNavigate: () => () => undefined,
      };
    },
    { endpoint: apiUrl, token: headers.authorization.replace("Bearer ", "") },
  );
  await page.goto("/#settings");

  const updateDiagnostics = page.getByTestId("update-diagnostics");
  await expect(updateDiagnostics).toContainText("自动更新");
  await expect(updateDiagnostics).toContainText("package checksum mismatch");
  await expect(updateDiagnostics).toContainText("更新包校验失败");
  await updateDiagnostics.getByRole("button", { name: "立即检查" }).click();
  await expect(updateDiagnostics).toContainText("正在检查本地更新");
  await updateDiagnostics.screenshot({
    path: resolve("output", "playwright", "e2e-update-diagnostics-dark.png"),
  });

  const codex = page.locator(".atm-integration-card").filter({ hasText: "Codex" });
  await expect(codex).toContainText("MCP");
  await expect(codex).toContainText("全局 ATM 规则");
  await expect(codex).toContainText("atm-plan");
  await expect(codex).toContainText("atm-task");
  await codex.getByRole("button", { name: "预览修改" }).click();
  await expect(page.getByText("Codex 规则修改预览")).toBeVisible();
  await expect(page.locator(".atm-integration-preview pre")).toContainText(
    "AYANAMI_TASK_MANAGER:BEGIN",
  );
  const claudeCode = page.locator(".atm-integration-card").filter({ hasText: "Claude Code" });
  await expect(claudeCode).toContainText("与 Claude Desktop 共用");
  await expect(claudeCode).toContainText("未检测到");
  await expect(claudeCode.getByRole("button", { name: "安装" })).toBeDisabled();
  await claudeCode.scrollIntoViewIfNeeded();
  await claudeCode.screenshot({
    path: resolve("output", "playwright", "e2e-claude-code-integration-dark.png"),
  });
});

test("项目视图、全局搜索和保存视图走真实 API", async ({ page }, testInfo) => {
  const savedViewName = `E2E 可开始 ${testInfo.repeatEachIndex}-${Date.now().toString(36)}`;
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/#project:E2E");
  await page.getByRole("tab", { name: "看板" }).click();
  await expect(page.getByText("待开始", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "时间线", exact: true }).click();
  await expect(page.getByText(/任务已创建/u).first()).toBeVisible();
  await page.getByRole("tab", { name: "记录", exact: true }).click();
  await expect(page.getByText("还没有项目记录")).toBeVisible();
  await page.getByRole("tab", { name: "列表" }).click();

  const taskSort = page.getByRole("button", { name: "按任务排序" });
  const prioritySort = page.getByRole("button", { name: "按优先级排序" });
  const statusSort = page.getByRole("button", { name: "按状态排序" });
  const updatedSort = page.getByRole("button", { name: "按更新时间排序" });
  await expect(page.getByRole("columnheader", { name: /任务/u })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  const taskNumbers = async () =>
    (await page.locator(".atm-table tbody tr td:first-child .atm-key").allTextContents()).map(
      (key) => Number(/-T-(\d+)$/u.exec(key.trim())?.[1] ?? -1),
    );
  const descendingTaskNumbers = await taskNumbers();
  expect(descendingTaskNumbers).toEqual(
    [...descendingTaskNumbers].sort((left, right) => right - left),
  );
  await taskSort.click();
  await expect(page.getByRole("columnheader", { name: /任务/u })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  const ascendingTaskNumbers = await taskNumbers();
  expect(ascendingTaskNumbers).toEqual(
    [...ascendingTaskNumbers].sort((left, right) => left - right),
  );
  await taskSort.click();
  const spacing = await page.evaluate(() => {
    const projection = document.querySelector(".atm-projection-panel")?.getBoundingClientRect();
    const reconcile = document.querySelector(".atm-project-reconcile")?.getBoundingClientRect();
    const loadStatus = document.querySelector(".atm-cursor-load-status")?.getBoundingClientRect();
    const taskPanel = document.querySelector("#project-task-panel")?.getBoundingClientRect();
    return {
      reconcileGap: projection && reconcile ? reconcile.top - projection.bottom : -1,
      taskPanelGap: loadStatus && taskPanel ? taskPanel.top - loadStatus.bottom : -1,
    };
  });
  expect(spacing.reconcileGap).toBeGreaterThanOrEqual(16);
  expect(spacing.taskPanelGap).toBeGreaterThanOrEqual(10);
  await page.locator(".atm-content").screenshot({
    path: resolve("output", "playwright", "project-task-spacing-number-sort.png"),
  });
  await prioritySort.click();
  await expect(page.getByRole("columnheader", { name: /优先级/u })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  await expect(page.locator(".atm-table tbody tr").first()).toContainText("验证键盘与焦点");
  await prioritySort.click();
  await expect(page.getByRole("columnheader", { name: /优先级/u })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await expect(page.locator(".atm-table tbody tr").first()).toContainText("验证搜索与保存视图");
  await statusSort.click();
  await expect(page.getByRole("columnheader", { name: /状态/u })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  await expect(page.locator(".atm-table th[aria-sort]")).toHaveCount(1);
  await updatedSort.click();
  await expect(page.getByRole("columnheader", { name: /更新/u })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  await expect(page.locator(".atm-table th[aria-sort]")).toHaveCount(1);

  await expect(page.locator(".atm-filterbar select")).toHaveCount(0);
  const statusFilter = page.getByRole("combobox", { name: "状态筛选" });
  await statusFilter.click();
  const statusSelect = statusFilter.locator("..");
  await expect(statusSelect).toHaveAttribute("data-open-input", "pointer");
  expect(
    await statusSelect.locator(".atm-select-popover").evaluate((element) =>
      getComputedStyle(element)
        .transitionDuration.split(",")
        .some((duration) => duration.trim() !== "0s"),
    ),
  ).toBe(true);
  await page.getByRole("option", { name: "可开始" }).click();
  await expect(statusFilter).toContainText("可开始");

  const progressSourceFilter = page.getByRole("combobox", { name: "进度来源筛选" });
  await progressSourceFilter.focus();
  await page.keyboard.press("ArrowDown");
  const progressSourceSelect = progressSourceFilter.locator("..");
  await expect(progressSourceSelect).toHaveAttribute("data-open-input", "keyboard");
  await expect(page.getByRole("option", { name: "人工报告" })).toBeVisible();
  await expect(page.getByRole("option", { selected: true })).toBeFocused();
  expect(
    await progressSourceSelect
      .locator(".atm-select-popover")
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toBe("0s");
  expect(
    await progressSourceSelect
      .locator(".atm-select-trigger > svg")
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toBe("0s");
  await page.waitForTimeout(250);
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-custom-select-dark.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(progressSourceFilter).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(progressSourceSelect).toHaveAttribute("data-open-input", "keyboard");
  await expect(page.getByRole("option", { selected: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(progressSourceFilter).toBeFocused();

  page.once("dialog", (dialog) => dialog.accept(savedViewName));
  await page.getByRole("button", { name: "保存当前" }).click();
  await page.getByRole("combobox", { name: "保存视图" }).click();
  await expect(page.getByRole("option", { name: savedViewName })).toHaveCount(1);
  await page.keyboard.press("Escape");

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

test("系统通知可在全部、仅严重和不通知三档间持久化切换", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/#settings");

  const all = page.getByRole("radio", { name: /全部通知/u });
  const critical = page.getByRole("radio", { name: /仅严重事件/u });
  const off = page.getByRole("radio", { name: /不通知/u });
  await expect(all).toHaveAttribute("aria-checked", "true");
  await expect(all).toHaveAttribute("tabindex", "0");
  await all.focus();
  await page.keyboard.press("ArrowRight");
  await expect(critical).toBeFocused();
  await expect(critical).toHaveAttribute("aria-checked", "true");
  await expect(all).toHaveAttribute("aria-checked", "false");
  await expect(off).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("End");
  await expect(off).toBeFocused();
  await page.keyboard.press("Home");
  await expect(all).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(critical).toBeFocused();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(1);

  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存", { exact: true })).toBeVisible();
  await page.reload();
  await expect(critical).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(1);
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-notification-policy-dark.png"),
    fullPage: true,
  });
});

test("新品牌、抽屉空间层与 reduced motion 降级可用", async ({ page }) => {
  await page.goto("/#project:E2E");
  const logo = page.locator(".atm-brand img");
  await expect(logo).toBeVisible();
  expect(await logo.getAttribute("src")).toContain("logo");

  await page
    .getByRole("button", { name: /验证键盘与焦点/u })
    .first()
    .click();
  await expect(page.locator(".atm-drawer-backdrop")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "任务详情" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Control+n");
  const dialog = page.getByRole("dialog", { name: "新建任务" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
  expect(await dialog.evaluate((element) => getComputedStyle(element).transitionProperty)).toBe(
    "opacity",
  );
  await page.keyboard.press("Escape");
});

test("投影健康状态可在总览、项目和设置中查看并安全重试", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/#overview");
  const overviewProject = page.locator(".atm-overview-project").filter({ hasText: "E2E 验收项目" });
  await expect(overviewProject.locator(".atm-projection-summary")).toContainText("已追平");
  await expect(overviewProject.locator(".atm-projection-summary")).toContainText("lag 0");
  const api = await createRequest.newContext({ extraHTTPHeaders: headers });
  const projectResponse = await api.get(`${apiUrl}/projects/E2E`);
  expect(projectResponse.ok()).toBeTruthy();
  const project = (await projectResponse.json()) as { id: string };
  const escapedProjectId = project.id.replaceAll("'", "''");
  const registry = new Database(resolve("output", "e2e", "data", "registry", "registry.sqlite"));
  const trigger = "fail_e2e_projection_health";

  try {
    registry.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    registry.exec(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE OF project_sequence ON project_summary_cache
      WHEN NEW.project_id = '${escapedProjectId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected E2E projection failure');
      END;
    `);
    const record = await api.post(`${apiUrl}/projects/E2E/ui/records`, {
      data: {
        opId: "e2e-projection-deferred",
        kind: "FACT",
        title: "Projection E2E failure injection",
        summary: "A committed project write remains durable while Registry projection is deferred.",
      },
    });
    expect(record.status()).toBe(201);
    expect(await record.json()).toMatchObject({
      projection: {
        status: "DEFERRED",
        retryScheduled: true,
        lastError: expect.stringContaining("injected E2E projection failure"),
      },
    });

    await page.reload();
    await expect(overviewProject.locator(".atm-projection-summary")).toContainText("等待重试");
    await expect(overviewProject.locator(".atm-projection-summary")).toContainText("lag 1");
    await expect(page.getByText("E2E 数据投影等待重试（lag 1）", { exact: true })).toBeVisible();
    await page.screenshot({
      path: resolve("output", "playwright", "e2e-projection-deferred-overview-dark.png"),
      fullPage: true,
    });

    await page.locator(".atm-sidebar").getByRole("button", { name: "E2E 验收项目" }).click();
    const projectPanel = page.getByRole("region", { name: "数据投影" });
    await expect(projectPanel).toBeVisible();
    await expect(projectPanel.getByText("等待重试", { exact: true })).toBeVisible();
    await expect(projectPanel.getByText("lag 1", { exact: true })).toBeVisible();
    await expect(projectPanel.getByText(/injected E2E projection failure/u)).toBeVisible();
    await page.screenshot({
      path: resolve("output", "playwright", "e2e-projection-deferred-project-dark.png"),
      fullPage: true,
    });

    registry.exec(`DROP TRIGGER ${trigger}`);
    await projectPanel.getByRole("button", { name: "立即重试" }).click();
    await expect(page.getByText("E2E 数据投影已追平", { exact: true })).toBeVisible();
    await expect(projectPanel.getByText("已追平", { exact: true })).toBeVisible();
    await expect(projectPanel.getByText("lag 0", { exact: true })).toBeVisible();
    await page.screenshot({
      path: resolve("output", "playwright", "e2e-projection-recovered-project-dark.png"),
      fullPage: true,
    });

    await page.locator(".atm-sidebar").getByRole("button", { name: "设置" }).click();
    const systemPanel = page.getByRole("region", { name: "全局投影状态" });
    await expect(systemPanel).toBeVisible();
    await expect(systemPanel.getByText("已追平", { exact: true })).toBeVisible();
    await expect(systemPanel.getByText("待重试 0", { exact: true })).toBeVisible();
  } finally {
    try {
      registry.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    } finally {
      registry.close();
      await api.dispose();
    }
  }
});
