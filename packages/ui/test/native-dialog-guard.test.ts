import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// 系统原生弹窗由操作系统绘制，和界面风格完全脱节；window.prompt 在 Electron 里更是
// 直接抛 "not supported"，靠它取输入的按钮在桌面端点了没有任何反应。
// 这条守卫扫渲染层和主进程的生产代码，出现即红。

const roots = [
  join(process.cwd(), "packages", "ui", "src"),
  join(process.cwd(), "apps", "desktop", "src"),
];

const patterns: Array<[string, RegExp]> = [
  ["window 原生弹窗", /\b(?:window|globalThis|self)\s*\.\s*(?:alert|confirm|prompt)\s*\(/gu],
  ["裸调用原生弹窗", /(?<![\w$.])(?:alert|confirm|prompt)\s*\(/gu],
  ["Electron 系统消息框", /\bdialog\s*\.\s*show(?:MessageBox|MessageBoxSync|ErrorBox)\s*\(/gu],
];

function withoutComments(source: string): string {
  // 保留换行，行号才对得上。
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");
}

export function nativeDialogCalls(files: Record<string, string>): string[] {
  const hits: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    const code = withoutComments(source);
    for (const [label, pattern] of patterns) {
      for (const match of code.matchAll(pattern)) {
        const line = code.slice(0, match.index).split("\n").length;
        hits.push(`${file}:${line} ${label}: ${match[0]}`);
      }
    }
  }
  return hits;
}

function productionSources(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|tsx)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name))
        files[relative(process.cwd(), path)] = readFileSync(path, "utf8");
    }
  };
  for (const root of roots) walk(root);
  return files;
}

describe("原生弹窗守卫", () => {
  it("生产代码里没有 confirm / prompt / alert 与 Electron 系统消息框", () => {
    const sources = productionSources();
    // 扫描面不能是空的，否则永远是绿的。
    expect(Object.keys(sources).length).toBeGreaterThan(60);
    for (const expected of ["task-drawer.tsx", "main.ts", "window-host.ts"])
      expect(Object.keys(sources).some((file) => file.endsWith(expected))).toBe(true);
    expect(nativeDialogCalls(sources)).toEqual([]);
  });

  it("阳性对照：每种写法都会被抓到，应用内对话框与注释不会误报", () => {
    const hits = nativeDialogCalls({
      "a.tsx": 'if (window.confirm("确定？")) run();',
      "b.tsx": "const name = window.prompt ( '名称' );",
      "c.tsx": 'if (confirm("裸调用")) run();',
      "d.tsx": 'globalThis.alert("x");',
      "e.ts": 'await dialog.showMessageBox(win, { message: "x" });',
      "f.ts": 'dialog.showErrorBox("标题", "内容");',
    });
    expect(hits.map((hit) => hit.split(":")[0])).toEqual([
      "a.tsx",
      "b.tsx",
      "c.tsx",
      "d.tsx",
      "e.ts",
      "f.ts",
    ]);

    expect(
      nativeDialogCalls({
        "ok.tsx": [
          "// 原来这里是 window.confirm(...)，Electron 不支持 prompt()",
          '/* window.prompt("旧写法") */',
          'if (await dialogs.confirm({ title: "t", message: "m", confirmLabel: "c" })) run();',
          'const value = await useDialogs().prompt({ title: "t", label: "l", confirmLabel: "c" });',
        ].join("\n"),
      }),
    ).toEqual([]);
  });
});
