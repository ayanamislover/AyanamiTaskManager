import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, searchKnowledge } from "../src/index.js";

// 短于三个字符的查询走不了 trigram FTS，只能扫正文，而那一支用的是 LIKE。
// LIKE 会把 %、_ 和反斜杠当模式语法——必须转义成字面量。
//
// knowledge.test.ts 里那条特殊字符用例是用 limit: 1 断言「能召回 1 条」的，
// 通配符泄漏在那里看不出来：`_` 匹配任意单字符时结果照样是 1 条。所以这里换个
// 量法——让只有一部分条目含目标字面量，再数召回条数。

const directories: string[] = [];
const managers: AyanamiDatabaseManager[] = [];
const migrationsRoot = resolve("migrations");

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true, maxRetries: 8 });
});

async function open() {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-knowledge-literals-"));
  directories.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
  managers.push(manager);
  return manager.knowledge.open();
}

const bodies = {
  underscore: "带下划线 snake_case 的条目",
  percent: "带百分号 99% 的条目",
  backslash: "带反斜杠 C:\\path 的条目",
  plain: "干净条目，不含任何模式字符",
  plainToo: "另一条干净条目，同样不含模式字符",
};

describe("知识搜索里的模式字符", () => {
  it("短查询里的 %、_ 和反斜杠按字面量匹配，不当通配符", async () => {
    const repository = await open();
    for (const [slug, bodyMarkdown] of Object.entries(bodies))
      repository.save({
        opId: `create-${slug}`,
        expectedVersion: 0,
        slug,
        title: slug,
        summary: slug,
        bodyMarkdown,
      });

    const slugsFor = (query: string) =>
      searchKnowledge(repository, { query, limit: 50, maxChars: 50_000 })
        .hits.map((hit) => (hit as { slug: string }).slug)
        .sort();

    // `_` 当通配符就会匹配任意单字符，五条全中；当字面量只该中一条。
    expect(slugsFor("_")).toEqual(["underscore"]);
    // `%` 当通配符会匹配任意子串，同样五条全中。
    expect(slugsFor("%")).toEqual(["percent"]);
    // 反斜杠是 ESCAPE 字符本身，没转义会把后面那个 % 吃掉，模式就变成了「以 % 结尾」。
    expect(slugsFor("\\")).toEqual(["backslash"]);

    // 阳性对照：这条用例要有意义，前提是库里确实不止一条，且普通短查询能正常召回。
    expect(slugsFor("条目").length).toBe(5);
    expect(slugsFor("不存在的词")).toEqual([]);
  });
});
