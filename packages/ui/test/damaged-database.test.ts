import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DataSourceState } from "../src/contracts.js";
import { DamagedDatabasePage } from "../src/features/damaged-database.js";

const COMMAND =
  "& 'C:\\Users\\u\\AppData\\Local\\AyanamiTaskManager\\app-3.0.0\\resources\\atm.exe' recover --offline";

type Backups = Pick<Extract<DataSourceState, { state: "DAMAGED" }>, "backups" | "backupsError">;

function render(listed: Backups = { backups: null, backupsError: null }): string {
  return renderToStaticMarkup(
    createElement(DamagedDatabasePage, {
      source: {
        state: "DAMAGED",
        generation: "01K7GENERATION",
        reason: "the database cannot be read: file is not a database",
        command: COMMAND,
        dataDir: "C:\\Users\\u\\AppData\\Local\\AyanamiTaskManager3",
        ...listed,
      },
      copy: async () => undefined,
    }),
  );
}

function backupList(markup: string): string {
  const start = markup.indexOf("整库备份</h2>");
  expect(start).toBeGreaterThan(0);
  return markup.slice(start);
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
    // 命令是给 PowerShell 的（宿主按 PowerShell 的语法拼，W8 关口 peer r1 P2-01），说明里就只说 PowerShell。
    expect(markup).toContain(
      "&amp; &#x27;C:\\Users\\u\\AppData\\Local\\AyanamiTaskManager\\app-3.0.0\\resources\\atm.exe&#x27; recover --offline",
    );
    expect(steps).toContain("打开 PowerShell");
    expect(steps).not.toContain("命令提示符");
    expect(markup).toContain("复制恢复命令");
    expect(markup).toContain("file is not a database");
    expect(markup).toContain("01K7GENERATION");
    expect(markup).not.toContain('role="radiogroup"');
  });

  it("W8h：宿主还在核对时显示载入中，列不出时给原因原文，没有备份时说明找不到来源", () => {
    expect(backupList(render())).toContain("atm-skeleton");
    const failed = backupList(render({ backups: null, backupsError: "io: Access is denied." }));
    expect(failed).toContain("列不出备份：io: Access is denied.");
    expect(failed).not.toContain("atm-skeleton");
    const none = backupList(render({ backups: [], backupsError: null }));
    expect(none).toContain("没有找到整库备份");
    expect(none).not.toContain("atm-skeleton");
  });

  it("W8h：逐份列出备份，标出恢复命令默认用的那一份（第一份可用的），不能用的写明原因", () => {
    const list = backupList(
      render({
        backups: [
          {
            id: "01K7NEWEST",
            kind: "DAILY",
            createdAt: "2026-10-13T00:00:00.000Z",
            status: "UNUSABLE",
            problem: "atm.sqlite does not match its hash",
          },
          {
            id: "01K7CHOSEN",
            kind: "MANUAL",
            createdAt: "2026-10-12T00:00:00.000Z",
            status: "USABLE",
            problem: null,
          },
          {
            id: "01K7OLDER",
            kind: "PRE_SOMETHING",
            createdAt: "2026-10-11T00:00:00.000Z",
            status: "USABLE",
            problem: null,
          },
        ],
        backupsError: null,
      }),
    );
    const rows = list.split('class="atm-row"').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("每日备份");
    expect(rows[0]).toContain("01K7NEWEST");
    expect(rows[0]).toContain("atm.sqlite does not match its hash");
    expect(rows[0]).toContain("不能用");
    expect(rows[1]).toContain("手动备份");
    expect(rows[1]).toContain("<code>01K7CHOSEN</code>");
    expect(rows[1]).toContain("恢复命令默认用这一份");
    // 不认识的种类照原文；第二份可用的只是「可用」。
    expect(rows[2]).toContain("PRE_SOMETHING");
    expect(rows[2]).toContain("可用");
    expect(rows[2]).not.toContain("默认用这一份");
  });
});
