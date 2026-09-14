import { mkdirSync } from "node:fs";
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

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.accept();
  });
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
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.accept();
  });
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
