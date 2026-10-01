import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { relativeToRepository } from "./css-source-graph.js";
import {
  appEntryHtmlFiles,
  nativeSelectOffenders,
  nativeSelectScanFiles,
} from "./native-select-scan.js";

// 原生 <select> 的弹层由操作系统绘制（Windows 上是直角白框），设计系统管不到；下拉一律自绘。
// 桌面端原来的守卫（apps/desktop/test/design-system-guards.test.ts）只认 `<select ` 与 `<select>`，
// 漏了自闭合、createElement 与大写 HTML，也扫不到 src 外的 index.html；这里按手机端守卫的写法全量补上。

function scannedSources(): Record<string, string> {
  return Object.fromEntries(
    nativeSelectScanFiles().map((file) => [relativeToRepository(file), readFileSync(file, "utf8")]),
  );
}

describe("原生 select 守卫（全部生产代码）", () => {
  it("桌面、手机与各包的生产代码、页面入口里都没有原生 select", () => {
    const files = scannedSources();
    // 扫描面不能是空的，否则永远是绿的。
    expect(Object.keys(files).length).toBeGreaterThan(200);
    expect(appEntryHtmlFiles().map(relativeToRepository)).toEqual(
      expect.arrayContaining(["apps/desktop/index.html", "apps/mobile/index.html"]),
    );
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "apps/desktop/index.html",
        "apps/desktop/src/renderer.tsx",
        "packages/ui/src/components/atm-select.tsx",
        "apps/mobile/src/ui/select.tsx",
      ]),
    );
    expect(nativeSelectOffenders(files)).toEqual([]);
  });

  it("阳性对照：把真实文件写回原生 select 的各种写法都会红，自绘组件与相近的名字不误报", () => {
    const files = scannedSources();
    const desktopTsx = Object.entries(files).find(
      ([file, source]) => file.startsWith("packages/ui/src/") && source.includes("<AtmSelect"),
    );
    expect(desktopTsx).toBeDefined();
    const [file, source] = desktopTsx!;
    expect(nativeSelectOffenders({ [file]: source.replace("<AtmSelect", "<select") })).toEqual([
      file,
    ]);

    const html = files["apps/desktop/index.html"]!;
    expect(html).toContain("<body");
    expect(
      nativeSelectOffenders({
        "apps/desktop/index.html": html.replace("<body>", "<body><SELECT id=x></SELECT>"),
      }),
    ).toEqual(["apps/desktop/index.html"]);

    expect(
      nativeSelectOffenders({
        "a.tsx": "export const Bad = () => <select />;",
        "b.tsx": "<select/>",
        "c.ts": 'document.createElement("select");',
        "d.ts": "createElement('select', null)",
        "e.html": "<Select name=x></Select>",
        "ok-1.tsx": "<AtmSelect label='x' />",
        "ok-2.tsx": "<Select label='x' />",
        "ok-3.tsx": "const selected = <selection-list />;",
      }),
    ).toEqual(["a.tsx", "b.tsx", "c.ts", "d.ts", "e.html"]);
  });
});
