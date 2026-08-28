import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionCssText, productionFiles } from "../../../packages/ui/test/css-source-graph.js";

const styles = productionCssText();

function tableBodies(sources: readonly string[]): string[] {
  return sources.flatMap((source) => [...source.matchAll(tableOpen)].map((match) => match[1]!));
}

const productionTsx = productionFiles(".tsx").map((path) => readFileSync(path, "utf8"));

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
    const mutatedBody = tableRule.exec(
      styles.replace("table-layout: fixed", "table-layout: auto"),
    )?.[1];
    expect(mutatedBody).not.toMatch(/table-layout:\s*fixed/u);
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
    const between = tableBodies(productionTsx);
    // 扫不到表格同样会让断言空转成绿，先把扫描面本身钉住。
    expect(between.length).toBeGreaterThanOrEqual(2);
    expect(between.filter((chunk) => !chunk.includes("<colgroup>"))).toEqual([]);
    // 真实生产变异：逐条移除一张表的 colgroup，守卫必须抓到恰好一张坏表。
    const sourceWithTable = productionTsx.find((source) => source.includes("<colgroup>"))!;
    const mutated = productionTsx.map((source) =>
      source === sourceWithTable ? source.replace("<colgroup>", "<div>") : source,
    );
    expect(tableBodies(mutated).filter((chunk) => !chunk.includes("<colgroup>"))).toHaveLength(1);
    // 独立坏 fixture 同样必须验红，避免递归扫描恰好漏掉未来移动后的文件。
    const badFixture = ['<table className="atm-table">\n  <thead>'];
    expect(tableBodies(badFixture)).toHaveLength(1);
    expect(tableBodies(badFixture)[0]).not.toContain("<colgroup>");
  });
});
