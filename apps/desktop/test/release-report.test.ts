import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nonBlockingItems, stageProvenance } from "../../../scripts/release-report.js";

const CHECKLIST = readFileSync(join(process.cwd(), "docs", "release-checklist.md"), "utf8");
const VERSION = (
  JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string }
).version;

describe("发布报告的证据出处", () => {
  // 复用的阶段拿的是上一轮的报告。证据仍然成立，但读 summary.md 的人分辨不出
  // 「本轮测的」和「上一轮测的」——不写出来就等于把没做的事写成做了。
  it("复用的阶段要在报告里标出来，重跑的不标", () => {
    const stages = {
      e2e: { reuse: true, reason: "stage-inputs-unchanged" },
      benchmark: { reuse: false, reason: "stage-inputs-changed" },
    };
    expect(stageProvenance(stages, "e2e")).toBe("（沿用上一轮结果：本轮输入未变）");
    expect(stageProvenance(stages, "benchmark")).toBe("");
    // 旧格式的报告没有 stages 字段，这时不能凭空说「沿用」。
    expect(stageProvenance(undefined, "e2e")).toBe("");
    expect(stageProvenance(stages, "distribution-smoke")).toBe("");
  });
});

describe("已知非阻塞剩余项", () => {
  it("从清单的表格里读条目，跳过表头与分隔行", () => {
    const markdown = [
      "## 9.9.9 非阻塞剩余项",
      "",
      "说明文字，不该被当成条目。",
      "",
      "| 条目 | 缺口 |",
      "| ---- | ---- |",
      "| 甲   | 没有用例 |",
      "| 乙   | 没有断言 |",
      "",
      "## 下一节",
      "",
      "| 不该被读到 | x |",
    ].join("\n");
    expect(nonBlockingItems(markdown, "9.9.9")).toEqual(["甲", "乙"]);
  });

  // 清单没跟着升版重置时，任何答案都不可信——而“无”恰好是最坏的那个默认值：
  // 它会把四条已知缺口从发布报告里抹掉。
  it("找不到当前版本的小节就抛，不返回空名单", () => {
    expect(() => nonBlockingItems("## 1.0.0 非阻塞剩余项\n", "9.9.9")).toThrow(
      /CHECKLIST_SECTION_MISSING/u,
    );
  });

  // 阳性对照：真实清单里当前版本的小节必须读得出条目。解析器烂掉、或者清单被
  // 改成别的结构时，这条先红——否则 summary.md 会安静地退回“无”。
  it("真实清单读得出当前版本的剩余项", () => {
    const items = nonBlockingItems(CHECKLIST, VERSION);
    expect(items.length).toBeGreaterThan(0);
    expect(items).toContain("空闲项目数据库 5 分钟 LRU 关闭");
  });
});
