import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const uiRoot = join(process.cwd(), "packages", "ui", "src");
const styles = readFileSync(join(uiRoot, "styles.css"), "utf8");
const app = readFileSync(join(uiRoot, "app.tsx"), "utf8");

// 默认的 auto 布局按内容分配列宽：任务标题那一列的 max-content 会把表撑开，
// 其余列被压到 min-content——中文的 min-content 是一个字宽，于是表头和单元格
// 逐字竖排。1366 下实测：表头高度 39px → 85px，层级列 36px，状态单元格高 773px。
const tableRule = /\.atm-table\s*\{([^}]*)\}/u;
// 窄列必须不折行；需要折行的单元格单独开口（.atm-row-title / .atm-cell-wrap）。
const cellRule = /\.atm-table th,\s*\.atm-table td\s*\{([^}]*)\}/u;
// 每张 .atm-table 都要自带 colgroup：table-layout: fixed 下没有 colgroup 就会
// 把列宽均分，任务列反而更窄。
const tableOpen = /<table className="atm-table">([\s\S]{0,1200}?)<thead>/gu;

describe("任务表列宽", () => {
  it(".atm-table 必须固定列宽布局", () => {
    const body = tableRule.exec(styles)?.[1];
    expect(body).toBeTruthy();
    expect(body).toMatch(/table-layout:\s*fixed/u);
    // 阳性对照：正则写错就会一直取不到规则体而误判。
    expect(tableRule.exec(".atm-table { table-layout: auto; }")?.[1]).toContain("auto");
  });

  it("表头与单元格默认不折行，超宽用省略号而不是竖排", () => {
    const body = cellRule.exec(styles)?.[1];
    expect(body).toBeTruthy();
    expect(body).toMatch(/white-space:\s*nowrap/u);
    expect(body).toMatch(/text-overflow:\s*ellipsis/u);
    expect(body).toMatch(/overflow:\s*hidden/u);
  });

  it("允许折行的两处单元格各自限定行数，不得无限增高", () => {
    expect(styles).toMatch(/\.atm-table \.atm-row-title\s*\{[^}]*-webkit-line-clamp:\s*3/u);
    expect(styles).toMatch(/\.atm-cell-wrap\s*\{[^}]*-webkit-line-clamp:\s*2/u);
    // 长英文标题没有断词点，不允许任意处断开就会直接溢出列宽。
    expect(styles).toMatch(/\.atm-table \.atm-row-title\s*\{[^}]*overflow-wrap:\s*anywhere/u);
  });

  it("每一张 .atm-table 都必须自带 colgroup", () => {
    const between = [...app.matchAll(tableOpen)].map((match) => match[1]!);
    // 扫不到表格同样会让断言空转成绿，先把扫描面本身钉住。
    expect(between.length).toBeGreaterThanOrEqual(2);
    expect(between.filter((chunk) => !chunk.includes("<colgroup>"))).toEqual([]);
    // 阳性对照：没有 colgroup 的表格必须被这条正则抓出来。
    const bad = [...'<table className="atm-table">\n  <thead>'.matchAll(tableOpen)];
    expect(bad).toHaveLength(1);
    expect(bad[0]![1]).not.toContain("<colgroup>");
  });
});
