import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, request as createRequest, test } from "@playwright/test";

const apiUrl = "http://127.0.0.1:4394/api/v1";
const headers = { authorization: "Bearer e2e-test-token" };
const longSidebarProjectName =
  "Codex Agent Permission Preflight And Deployment Readiness Verification";

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
        evidence: [{ kind: "E2E", ref: suffix }],
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
    await page.getByRole("tablist").getByRole("button", { name: "时间线" }).click();
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
  const listedTasks = await api.get(`${apiUrl}/projects/E2E/work-items?limit=100`);
  expect(listedTasks.ok()).toBeTruthy();
  const taskList = (await listedTasks.json()) as Array<Record<string, any>>;
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
    const agentRows = (await agents.json()) as Array<Record<string, any>>;
    const primaryAgent = agentRows.find((agent) => agent.id === primarySession);
    expect(primaryAgent).toBeTruthy();
    expect(String(primaryAgent.git_branch || "")).not.toBe("");
    expect(String(primaryAgent.worktree_root || "")).not.toBe("");
    expect(String(primaryAgent.git_head || "")).not.toBe("");
    await expect(primary).toContainText(String(primaryAgent.git_branch));
    await expect(primary).toContainText(String(primaryAgent.worktree_root).split("\\").pop()!);

    await primary.getByText(/详细上下文与历史/u).click();
    await expect(primary).toContainText("工作目录");
    await expect(primary).toContainText("HEAD");
    await expect(primary).toContainText("持续时间");
    await expect(primary).toContainText(/clean|dirty|未观察/u);

    const warning = page.getByRole("status");
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
    await expect(drawer).toContainText(String(primaryAgent.git_branch));
    await expect(drawer).toContainText("Worktree");
    await expect(drawer).toContainText("HEAD");
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

test("项目视图、全局搜索和保存视图走真实 API", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/#project:E2E");
  await page.getByRole("button", { name: "看板" }).click();
  await expect(page.getByText("待开始", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "时间线", exact: true }).click();
  await expect(page.getByText(/任务已创建/u).first()).toBeVisible();
  await page.getByRole("button", { name: "记录", exact: true }).click();
  await expect(page.getByText("还没有项目记录")).toBeVisible();
  await page.getByRole("button", { name: "列表" }).click();

  const prioritySort = page.getByRole("button", { name: "按优先级排序" });
  const statusSort = page.getByRole("button", { name: "按状态排序" });
  const updatedSort = page.getByRole("button", { name: "按更新时间排序" });
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
  await page.getByRole("option", { name: "可开始" }).click();
  await expect(statusFilter).toContainText("可开始");

  const progressSourceFilter = page.getByRole("combobox", { name: "进度来源筛选" });
  await progressSourceFilter.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option", { name: "人工报告" })).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({
    path: resolve("output", "playwright", "e2e-custom-select-dark.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(progressSourceFilter).toBeFocused();

  page.once("dialog", (dialog) => dialog.accept("E2E 可开始"));
  await page.getByRole("button", { name: "保存当前" }).click();
  await page.getByRole("combobox", { name: "保存视图" }).click();
  await expect(page.getByRole("option", { name: "E2E 可开始" })).toHaveCount(1);
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
  await critical.click();
  await expect(critical).toHaveAttribute("aria-checked", "true");
  await expect(all).toHaveAttribute("aria-checked", "false");
  await expect(off).toHaveAttribute("aria-checked", "false");
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
