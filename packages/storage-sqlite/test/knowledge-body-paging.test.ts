import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, getKnowledgeForAgent } from "../src/index.js";

// 分页的两条不变量：拼回来要等于原文，且每一页自己是合法 UTF-16。
// 后一条必须按页量——高低代理分到相邻两页时字符串一拼又变回原字符，
// 只看拼接结果是抓不到的。
//
// 代理对真被劈开这件事在当前实现里够不到，原因见 knowledge-queries.ts 里 boundary
// 的注释。所以这里钉的是「拼回来一致」「每页非空」「每页合法」，不是那个 snap 本身。

const directories: string[] = [];
const managers: AyanamiDatabaseManager[] = [];
const migrationsRoot = resolve("migrations");

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true, maxRetries: 8 });
});

async function open() {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-knowledge-paging-"));
  directories.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
  managers.push(manager);
  return manager.knowledge.open();
}

function readAll(
  repository: Awaited<ReturnType<typeof open>>,
  id: string,
  maxChars: number,
): { body: string; pages: string[] } {
  const pages: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = getKnowledgeForAgent(repository, {
      id,
      maxChars,
      ...(cursor === undefined ? {} : { cursor }),
    }) as { bodyMarkdown: string; nextCursor: string | null };
    pages.push(page.bodyMarkdown);
    if (!page.nextCursor) return { body: pages.join(""), pages };
    cursor = page.nextCursor;
    // 切点退回起点时这一页是空的、游标又指回原处，续读就此打转。
    if (pages.length > 400) throw new Error("游标不收敛");
  }
}

/**
 * 每一页自己必须是合法的 UTF-16。
 *
 * 光断言「拼回来等于原文」抓不到代理对被劈开：高低两半分到相邻两页，字符串一拼
 * 又变回原来那个字符，断言照样绿。可单页是要独立送进 JSON、送给 agent 的，
 * 那时半个代理就是坏数据。所以这条得按页量。
 */
function unpairedSurrogates(page: string): number {
  let count = 0;
  for (let index = 0; index < page.length; index += 1) {
    const unit = page.charCodeAt(index);
    if ((unit & 0xfc00) === 0xd800) {
      if ((page.charCodeAt(index + 1) & 0xfc00) === 0xdc00) index += 1;
      else count += 1;
    } else if ((unit & 0xfc00) === 0xdc00) count += 1;
  }
  return count;
}

describe("知识正文分页", () => {
  it("小预算逐页续读拼回的正文与原文逐字相等，含代理对与组合字符", async () => {
    const repository = await open();
    // 🍰 与 𝄞 是代理对；é́ 是基字符加两个组合记号；穿插 ASCII 让切点落在各种位置。
    const unit = "了解🍰的组合字é́和𝄞音符 mixed-ascii";
    const body = Array.from({ length: 60 }, (_, index) => `${index}:${unit}\n`).join("");
    const saved = repository.save({
      opId: "create",
      expectedVersion: 0,
      slug: "paging",
      title: "分页",
      summary: "分页",
      bodyMarkdown: body,
    });

    const small = readAll(repository, saved.id, 700);
    // 阳性对照：预算真的小到逼出了多页，否则下面只是在比一次性全文。
    expect(small.pages.length).toBeGreaterThan(1);
    expect(small.body).toBe(body);
    expect(small.pages.map(unpairedSurrogates)).toEqual(small.pages.map(() => 0));

    // 预算够大时应当一次读完，且与逐页拼出来的一致。
    const whole = readAll(repository, saved.id, 50_000);
    expect(whole.pages).toHaveLength(1);
    expect(whole.body).toBe(body);
  });

  it("正文正好落在代理对边界时不会切出孤立代理", async () => {
    const repository = await open();
    const body = "🍰".repeat(400);
    const saved = repository.save({
      opId: "create",
      expectedVersion: 0,
      slug: "surrogates",
      title: "代理对",
      summary: "代理对",
      bodyMarkdown: body,
    });

    const read = readAll(repository, saved.id, 700);
    expect(read.pages.length).toBeGreaterThan(1);
    expect(read.body).toBe(body);
    // 每一页单独看都必须只由完整的 🍰 组成。
    for (const page of read.pages) {
      expect(unpairedSurrogates(page)).toBe(0);
      expect(page.length % 2).toBe(0);
    }
  });

  it("正文全是代理对时，任何预算都要么整页干净地推进，要么明确报预算不足", async () => {
    const repository = await open();
    const body = "🍰".repeat(200);
    const saved = repository.save({
      opId: "create",
      expectedVersion: 0,
      slug: "budget-sweep",
      title: "预算扫描",
      summary: "预算扫描",
      bodyMarkdown: body,
    });

    // 逐个预算扫过去，是为了扫到「切点正好退回起点」那一格：那时这一页是空的，
    // 游标却指回原处，续读会死循环。正确行为是报 RESULT_TOO_LARGE。
    let paged = 0;
    let refused = 0;
    for (let maxChars = 360; maxChars <= 760; maxChars += 1) {
      let read;
      try {
        read = readAll(repository, saved.id, maxChars);
      } catch (error) {
        expect(error).toMatchObject({ code: "RESULT_TOO_LARGE" });
        refused += 1;
        continue;
      }
      paged += 1;
      expect(read.body).toBe(body);
      for (const page of read.pages) {
        expect(page.length).toBeGreaterThan(0);
        expect(unpairedSurrogates(page)).toBe(0);
      }
    }
    // 阳性对照：这段区间两种情况都要真的出现过，否则这条只是在空跑。
    expect(paged).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });
});
