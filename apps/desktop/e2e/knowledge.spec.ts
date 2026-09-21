import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("知识库可在真实界面创建、重试、载入历史并归档恢复", async ({ page }) => {
  mkdirSync(resolve("output", "playwright"), { recursive: true });
  await page.addInitScript(() => {
    window.localStorage.setItem("atm.theme", "dark");
    window.localStorage.setItem("atm.workspace.expanded", "false");
  });
  await page.goto("/#knowledge");
  await expect(page.getByRole("heading", { name: "知识库" })).toBeVisible();

  const suffix = Date.now().toString(36);
  const title = `E2E 知识 ${suffix}`;
  const slug = `e2e-knowledge-${suffix}`;
  const firstBody = "# 固定路径\n\n使用应用数据根保存本地知识。";
  const editedBody = "# 固定路径\n\n编辑后仍保留 Markdown 原文。\n\n- 可重试";

  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.locator("#knowledge-title").fill(title);
  await page.locator("#knowledge-slug").fill(slug);
  await page.locator("#knowledge-summary").fill("E2E 验证知识条目持久化和修订流程。");
  await page.locator("#knowledge-use-when").fill("验证本地知识库 UI");
  await page.locator("#knowledge-tags").fill("e2e,知识库");
  await page.locator("#knowledge-applies-to").fill("Windows");
  await page.locator("#knowledge-body").fill(firstBody);
  await page.getByRole("button", { name: "确认保存修订", exact: true }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("修订 v1", { exact: false })).toBeVisible();

  const patchOpIds: string[] = [];
  let failedOnce = false;
  await page.route("**/api/v1/knowledge", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const body = JSON.parse(request.postData() ?? "{}") as { opId?: string };
    patchOpIds.push(body.opId ?? "");
    if (!failedOnce) {
      failedOnce = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "INTERNAL_ERROR",
            message: "模拟保存失败，请重试。",
          },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.locator("#knowledge-body").fill(editedBody);
  await page.getByRole("button", { name: "确认保存修订", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("模拟保存失败");
  await expect(page.locator("#knowledge-body")).toHaveValue(editedBody);
  await page.getByRole("button", { name: "确认保存修订", exact: true }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("修订 v2", { exact: false })).toBeVisible();
  expect(patchOpIds).toHaveLength(2);
  expect(patchOpIds[0]).toBeTruthy();
  expect(patchOpIds[0]).toBe(patchOpIds[1]);
  await page.unroute("**/api/v1/knowledge");

  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.locator("#knowledge-body").fill(`${editedBody}\n\n当前头部版本。`);
  await page.getByRole("button", { name: "确认保存修订", exact: true }).click();
  await expect(page.getByText("修订 v3", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "修订历史", exact: true }).click();
  const firstRevision = page.locator(".atm-knowledge-history-row").filter({ hasText: "v1 ·" });
  await expect(firstRevision).toBeVisible();
  await firstRevision.getByRole("button", { name: "载入为新修订", exact: true }).click();
  await expect(page.getByRole("heading", { name: "编辑知识" })).toBeVisible();
  await expect(page.locator("#knowledge-body")).toHaveValue(firstBody);
  await expect(page.getByText("保存会创建新的当前修订", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "确认保存修订", exact: true }).click();
  await expect(page.getByText("修订 v4", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "归档条目", exact: true }).click();
  await expect(page.getByRole("button", { name: "恢复条目", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "知识库" })).toBeVisible();
  await expect(page.locator(".atm-knowledge-list-item").filter({ hasText: title })).toHaveCount(0);
  await page.getByLabel("包括已归档").check();
  const archivedHit = page.locator(".atm-knowledge-list-item").filter({ hasText: title });
  await expect(archivedHit).toHaveCount(1);
  await expect(archivedHit).toContainText("已归档");

  await archivedHit.click();
  await page.getByRole("button", { name: "恢复条目", exact: true }).click();
  await expect(page.getByRole("button", { name: "归档条目", exact: true })).toBeVisible();
  await page.getByLabel("包括已归档").uncheck();
  await expect(page.locator(".atm-knowledge-list-item").filter({ hasText: title })).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".atm-knowledge-list-item").filter({ hasText: title })).toHaveCount(1);

  await page.screenshot({
    path: resolve("output", "playwright", "e2e-knowledge-dark.png"),
    fullPage: true,
  });
});

test("保存期间锁定编辑草稿和竞争入口", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("atm.theme", "dark");
    window.localStorage.setItem("atm.workspace.expanded", "false");
  });
  await page.goto("/#knowledge");
  await expect(page.getByRole("heading", { name: "知识库" })).toBeVisible();

  const suffix = Date.now().toString(36);
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.locator("#knowledge-title").fill(`延迟保存知识 ${suffix}`);
  await page.locator("#knowledge-slug").fill(`delayed-knowledge-${suffix}`);
  await page.locator("#knowledge-summary").fill("验证保存期间不会继续编辑或切换入口。");
  await page.locator("#knowledge-body").fill("# 延迟保存\n\n原始草稿。");

  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/api/v1/knowledge**", async (route) => {
    if (route.request().method() === "GET") {
      await saveGate;
    }
    await route.continue();
  });

  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/v1/knowledge"),
  );
  await page.getByRole("button", { name: "确认保存修订", exact: true }).click();
  await saveResponse;
  await expect(page.locator("fieldset.atm-knowledge-editor-form")).toHaveAttribute("disabled", "");
  await expect(page.locator("#knowledge-title")).toBeDisabled();
  await expect(page.locator("#knowledge-body")).toBeDisabled();
  await expect(page.getByRole("button", { name: "新建", exact: true })).toBeDisabled();
  await expect(page.locator('input[type="file"]')).toBeDisabled();
  await expect(page.getByRole("button", { name: "导出 Markdown", exact: true })).toBeDisabled();
  await expect(page.locator("#knowledge-title")).toHaveValue(`延迟保存知识 ${suffix}`);

  releaseSave();
  await expect(page.getByRole("heading", { name: `延迟保存知识 ${suffix}` })).toBeVisible();
  await page.unroute("**/api/v1/knowledge**");
});

test("修订历史分页可从 120 个修订载入最早版本草稿", async ({ page, request }) => {
  const suffix = Date.now().toString(36);
  const title = `历史分页知识 ${suffix}`;
  const slug = `history-pagination-${suffix}`;
  const headers = {
    authorization: "Bearer e2e-test-token",
    "content-type": "application/json",
  };
  const saveUrl = "http://127.0.0.1:4394/api/v1/knowledge";
  let response = await request.post(saveUrl, {
    headers,
    data: {
      opId: `e2e-history-${suffix}-1`,
      expectedVersion: 0,
      slug,
      title,
      summary: "验证历史分页加载最早版本。",
      bodyMarkdown: "# history v1",
    },
  });
  expect(response.ok()).toBeTruthy();
  let entry = (await response.json()) as {
    id: string;
    version: number;
    revisionId: string;
  };
  for (let revision = 2; revision <= 120; revision += 1) {
    response = await request.post(saveUrl, {
      headers,
      data: {
        opId: `e2e-history-${suffix}-${revision}`,
        id: entry.id,
        expectedVersion: entry.version,
        expectedRevisionId: entry.revisionId,
        slug,
        title,
        summary: "验证历史分页加载最早版本。",
        bodyMarkdown: `# history v${revision}`,
      },
    });
    expect(response.ok()).toBeTruthy();
    entry = (await response.json()) as typeof entry;
  }

  await page.addInitScript(() => {
    window.localStorage.setItem("atm.theme", "dark");
    window.localStorage.setItem("atm.workspace.expanded", "false");
  });
  await page.goto("/#knowledge");
  await page.locator(".atm-knowledge-list-item").filter({ hasText: title }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: "修订历史", exact: true }).click();

  await expect(page.locator(".atm-knowledge-history-row").first()).toBeVisible();
  const loadMore = page.getByRole("button", { name: /加载更早修订/ });
  for (let pageNumber = 0; pageNumber < 2; pageNumber += 1) {
    await expect(loadMore).toBeVisible();
    await expect(loadMore).toBeEnabled();
    await loadMore.click();
  }
  const firstRevision = page.locator(".atm-knowledge-history-row").filter({ hasText: "v1 ·" });
  await expect(firstRevision).toBeVisible();
  await firstRevision.getByRole("button", { name: "载入为新修订", exact: true }).click();
  await expect(page.getByRole("heading", { name: "编辑知识" })).toBeVisible();
  await expect(page.locator("#knowledge-body")).toHaveValue("# history v1");
});

test("来源达到配额时不静默丢失并可删除修复", async ({ page }) => {
  mkdirSync(resolve("output", "playwright"), { recursive: true });
  await page.addInitScript(() => {
    window.localStorage.setItem("atm.theme", "dark");
    window.localStorage.setItem("atm.workspace.expanded", "false");
  });
  await page.goto("/#knowledge");

  const sourceRefs = Array.from({ length: 31 }, (_, index) => ({
    type: "manual",
    reference: `source-${index}`,
  }));
  const markdown = [
    "---json",
    JSON.stringify(
      {
        title: "来源配额修复",
        slug: `source-capacity-${Date.now().toString(36)}`,
        summary: "验证来源配额提示和修复入口。",
        sourceRefs,
      },
      null,
      2,
    ),
    "---",
    "",
    "# source capacity",
  ].join("\n");
  await page.locator('input[type="file"]').setInputFiles({
    name: "source-capacity.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(markdown),
  });
  await expect(page.getByText("来源引用（31/30）", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert").first()).toContainText("超过 30 条上限");
  await expect(page.getByRole("button", { name: "确认保存修订", exact: true })).toBeDisabled();
  await page.getByText("来源引用（31/30）", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve("output", "playwright", "audit114-sources-dark.png"),
    fullPage: true,
  });

  await page
    .getByRole("button", { name: /删除来源/ })
    .first()
    .click();
  await expect(page.getByText("来源引用（30/30）", { exact: true })).toBeVisible();
  const saveButton = page.getByRole("button", { name: "确认保存修订", exact: true });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expect(page.getByRole("heading", { name: "来源配额修复", exact: true })).toBeVisible();
  await expect(
    page.locator(".atm-knowledge-detail .atm-knowledge-sources .atm-row-sub"),
  ).toHaveCount(30);
});

test("慢历史读取不会覆盖用户随后开始的新草稿", async ({ page, request }) => {
  const suffix = Date.now().toString(36);
  const title = `慢历史读取知识 ${suffix}`;
  const slug = `slow-history-${suffix}`;
  const headers = {
    authorization: "Bearer e2e-test-token",
    "content-type": "application/json",
  };
  const saveUrl = "http://127.0.0.1:4394/api/v1/knowledge";
  let response = await request.post(saveUrl, {
    headers,
    data: {
      opId: `e2e-slow-history-${suffix}-1`,
      expectedVersion: 0,
      slug,
      title,
      summary: "验证慢历史读取不会覆盖新草稿。",
      bodyMarkdown: "# old body",
    },
  });
  expect(response.ok()).toBeTruthy();
  const entry = (await response.json()) as {
    id: string;
    version: number;
    revisionId: string;
  };
  response = await request.post(saveUrl, {
    headers,
    data: {
      opId: `e2e-slow-history-${suffix}-2`,
      id: entry.id,
      expectedVersion: entry.version,
      expectedRevisionId: entry.revisionId,
      slug,
      title,
      summary: "验证慢历史读取不会覆盖新草稿。",
      bodyMarkdown: "# current body",
    },
  });
  expect(response.ok()).toBeTruthy();

  await page.addInitScript(() => {
    window.localStorage.setItem("atm.theme", "dark");
    window.localStorage.setItem("atm.workspace.expanded", "false");
  });
  await page.goto("/#knowledge");
  await page.locator(".atm-knowledge-list-item").filter({ hasText: title }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: "修订历史", exact: true }).click();
  await expect(
    page.locator(".atm-knowledge-history-row").filter({ hasText: "v1 ·" }),
  ).toBeVisible();

  let releaseRevision!: () => void;
  const revisionGate = new Promise<void>((resolve) => {
    releaseRevision = resolve;
  });
  await page.route("**/api/v1/knowledge/**", async (route) => {
    if (route.request().method() === "GET" && route.request().url().includes("revisionId=")) {
      await revisionGate;
    }
    await route.continue();
  });
  const revisionRequest = page.waitForRequest(
    (request) => request.method() === "GET" && request.url().includes("revisionId="),
  );
  await page
    .locator(".atm-knowledge-history-row")
    .filter({ hasText: "v1 ·" })
    .getByRole("button", { name: "载入为新修订", exact: true })
    .click();
  await revisionRequest;

  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.locator("#knowledge-body").fill("# new draft while history is slow");
  await page.getByRole("button", { name: "确认保存修订", exact: true }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  releaseRevision();
  await expect(page.locator(".atm-knowledge-markdown")).toContainText(
    "# new draft while history is slow",
  );
  await page.unroute("**/api/v1/knowledge/**");
});

for (const count of [0, 29, 30]) {
  test(`${count} 条来源的真实导出导入可保存且保留原来源`, async ({ page, request }) => {
    const suffix = `${count}-${Date.now().toString(36)}`;
    const slug = `source-roundtrip-${suffix}`;
    const title = `来源往返 ${suffix}`;
    const sourceRefs = Array.from({ length: count }, (_, index) => ({
      type: "manual",
      reference: `original-${index}`,
    }));
    const response = await request.post("http://127.0.0.1:4394/api/v1/knowledge", {
      headers: { authorization: "Bearer e2e-test-token" },
      data: {
        opId: `source-roundtrip-${suffix}`,
        expectedVersion: 0,
        slug,
        title,
        summary: "真实导出导入来源往返验收",
        sourceRefs,
        bodyMarkdown: "# original body",
      },
    });
    expect(response.ok()).toBe(true);
    await page.goto("/#knowledge");
    await page.locator(".atm-knowledge-list-item").filter({ hasText: title }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 Markdown", exact: true }).click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path).not.toBeNull();
    await page.locator('input[type="file"]').setInputFiles({
      name: download.suggestedFilename(),
      mimeType: "text/markdown",
      buffer: readFileSync(path!),
    });
    await expect(page.getByRole("heading", { name: "新建知识草稿" })).toBeVisible();
    await page.locator("#knowledge-slug").fill(`${slug}-copy`);
    const expectedCount = Math.min(count + 1, 30);
    await expect(page.getByText(`来源引用（${expectedCount}/30）`, { exact: true })).toBeVisible();
    const savedPromise = page.waitForResponse(
      (result) =>
        result.request().method() === "POST" && result.url().endsWith("/api/v1/knowledge"),
    );
    await page.getByRole("button", { name: "确认保存修订", exact: true }).click();
    const savedResponse = await savedPromise;
    expect(savedResponse.ok()).toBe(true);
    const saved = await savedResponse.json();
    expect(saved.sourceRefs).toHaveLength(expectedCount);
    expect(saved.sourceRefs.slice(0, count)).toEqual(sourceRefs);
    expect(saved.bodyMarkdown).toBe("# original body");
    if (count < 30)
      expect(saved.sourceRefs.at(-1)).toEqual({
        type: "file",
        reference: download.suggestedFilename(),
      });
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  });
}
