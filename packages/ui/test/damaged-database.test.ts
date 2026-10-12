import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DamagedDatabasePage } from "../src/features/damaged-database.js";

const COMMAND =
  '"C:\\Users\\u\\AppData\\Local\\AyanamiTaskManager\\app-3.0.0\\resources\\atm.exe" recover --offline';

function render(): string {
  return renderToStaticMarkup(
    createElement(DamagedDatabasePage, {
      source: {
        state: "DAMAGED",
        generation: "01K7GENERATION",
        reason: "the database cannot be read: file is not a database",
        command: COMMAND,
        dataDir: "C:\\Users\\u\\AppData\\Local\\AyanamiTaskManager3",
      },
      copy: async () => undefined,
    }),
  );
}

describe("DamagedDatabasePage（W8f-3）", () => {
  it("说清楚没动数据、先退出再恢复，给出能直接运行的命令与原因原文", () => {
    const markup = render();
    expect(markup).toContain("数据库读不出，需要从备份恢复");
    expect(markup).toContain("没有改动它，也没有新建空库");
    // 恢复要独占准入：退出必须是第一步，重新打开是最后一步。
    const steps = markup.slice(markup.indexOf("<ol"), markup.indexOf("</ol>"));
    expect(steps.indexOf("完全退出")).toBeGreaterThan(0);
    expect(steps.indexOf("完全退出")).toBeLessThan(steps.indexOf("重新打开 ATM"));
    expect(markup).toContain(
      "&quot;C:\\Users\\u\\AppData\\Local\\AyanamiTaskManager\\app-3.0.0\\resources\\atm.exe&quot; recover --offline",
    );
    expect(markup).toContain("复制恢复命令");
    expect(markup).toContain("file is not a database");
    expect(markup).toContain("01K7GENERATION");
    expect(markup).not.toContain('role="radiogroup"');
  });
});
