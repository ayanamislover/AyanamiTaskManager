import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build, type RollupOutput } from "vite";

/**
 * 列表读取的时序守卫：真实 Chromium、真实 hook、生产的 query 策略。
 *
 * 这三条都不是纯函数能覆盖的——它们说的是「哪一轮读取还算数、谁能写界面、
 * 什么能进缓存」。仓库里没有 jsdom，所以把 hook 单独打成一个页面在浏览器里驱动，
 * 而不是靠源码契约描述行为。
 */
type HarnessCache = { key: string; status: string; data: unknown };
type SingleState = {
  items: string[];
  isLoading: boolean;
  hasMore: boolean;
  error: string | null;
  calls: Record<string, number>;
};
type MultiState = {
  entries: Record<string, { items: string[]; isLoading: boolean }>;
  calls: Record<string, number>;
};

declare global {
  interface Window {
    __start: (input: { multi?: boolean; schedule: Record<string, number[]> }) => void;
    __state: unknown;
    __cache: () => HarnessCache[];
    __refetch: () => void;
    __setEnabled: (next: boolean) => void;
    __setNames: (next: string[]) => void;
  }
}

let bundle = "";

test.beforeAll(async () => {
  const result = (await build({
    logLevel: "error",
    define: { "process.env.NODE_ENV": '"production"' },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve("apps", "desktop", "e2e", "fixtures", "cursor-collection-harness.ts"),
        formats: ["iife"],
        name: "cursorCollectionHarness",
      },
    },
  })) as RollupOutput[];
  bundle = result[0]!.output[0]!.code;
});

async function mount(page: Page, input: { multi?: boolean; schedule: Record<string, number[]> }) {
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ content: bundle });
  await page.evaluate((argument) => window.__start(argument), input);
}

test("慢的那一轮后到时不能把界面顶回旧结果", async ({ page }) => {
  // 第二轮刷新要 800ms、第三轮只要 100ms：第三轮先显示，第二轮之后才回来。
  await mount(page, { schedule: { X: [50, 800, 100] } });
  await expect(page.locator("#items")).toHaveText("X-R1");

  await page.evaluate(() => window.__refetch());
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__refetch());
  await expect(page.locator("#items")).toHaveText("X-R3");

  // 慢的第二轮此刻才回来，它手里那份是开跑时拍下的 R1 快照。
  await page.waitForTimeout(1200);
  await expect(page.locator("#items")).toHaveText("X-R3");
  const cached = (await page.evaluate(() => window.__cache())).find((entry) =>
    entry.key.includes("X"),
  );
  expect(cached?.status).toBe("success");
  expect((cached?.data as { items: { id: string }[] }).items.map((row) => row.id)).toEqual([
    "X-R3",
  ]);
});

test("停用时没读完的那一轮不能被缓存成空结果", async ({ page }) => {
  // 首轮要 800ms：50ms 就关掉这一块，1 秒后再打开，都在 3 秒新鲜期内。
  await mount(page, { schedule: { X: [800] } });
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__setEnabled(false));
  await expect(page.locator("#items")).toHaveText("");

  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__setEnabled(true));

  // 重新打开要立刻拿到完整结果，而不是一份「成功读到 0 条」的空缓存。
  await expect(page.locator("#items")).toHaveText("X-R1", { timeout: 500 });
  const state = (await page.evaluate(() => window.__state)) as SingleState;
  expect(state.error).toBeNull();
  // 那一轮读完了就该算数，不该为了补救再请求一次。
  expect(state.calls.X).toBe(1);
});

test("来源集合变化后旧请求晚到，不能清空已经读到的新结果", async ({ page }) => {
  // X 的第一次请求要 800ms，第二次只要 50ms：新一轮先读完 X，旧的那一轮才回来。
  await mount(page, { multi: true, schedule: { X: [800, 50], Y: [30] } });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__setNames(["X", "Y"]));
  await expect(page.locator("#items")).toHaveText("X:X-R2,Y:Y-R1");

  await page.waitForTimeout(900);
  const state = (await page.evaluate(() => window.__state)) as MultiState;
  expect(state.entries.X?.items).toEqual(["X-R2"]);
  expect(state.entries.Y?.items).toEqual(["Y-R1"]);
});
