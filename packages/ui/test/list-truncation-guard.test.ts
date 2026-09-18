import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 列表数据不许被写死的条数悄悄截断。
 *
 * 踩过的坑：侧栏活动项目 `.slice(0, 12)`。用户有 15 个项目，界面上只出现 12 个，
 * 没有任何提示说少了——而那个列表本来就是可滚动的，那个上限纯属白写。同一批里
 * 总览的「需要处理」「项目状态」、项目页三张管理摘要卡也一样：卡头的徽章写的是
 * 真实条数，列表却只画前几条，自己跟自己对不上。
 *
 * 规矩：要限高就让它滚（.atm-scroll-list），不要砍掉后面几条。
 * `.slice(0, N)` 只留给「把一段字符串夹短」——短哈希、日期前缀、带省略号的长文本。
 */
const ROOTS = [join("packages", "ui", "src"), join("apps", "desktop", "src")];

/** 允许的 `.slice(0, N)`：键是「相对路径|整行去空白」，值是为什么它不是列表截断。 */
const STRING_CLAMPS = new Map<string, string>([
  [
    "packages/ui/src/components/async-state.tsx|const message = rawMessage.length > 500 ? `${rawMessage.slice(0, 499)}…` : rawMessage;",
    "错误消息夹到 500 字，补省略号",
  ],
  [
    'packages/ui/src/features/agents.tsx|<strong>{String(session.git?.head || "不可用").slice(0, 10)}</strong>',
    "git 短哈希",
  ],
  ["packages/ui/src/features/knowledge-support.ts|.slice(0, 160);", "知识摘要夹到 160 字"],
  [
    'packages/ui/src/features/task-drawer.tsx|HEAD：{String(session.git?.head || "不可用").slice(0, 12)}',
    "git 短哈希",
  ],
  [
    'packages/ui/src/project-statistics-panel.tsx|HEAD {String(engineering.data.project.head).slice(0, 10)} ·{" "}',
    "git 短哈希",
  ],
  [
    "apps/desktop/src/agent-documentation-manifest.ts|.slice(0, 8)",
    "报错信息只列前 8 条不一致，后面用 +N 说明还有多少",
  ],
  [
    "apps/desktop/src/agent-documentation.ts|return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;",
    "文档摘要夹到 120 字，补省略号",
  ],
  [
    "apps/desktop/src/agent-documentation.ts|.slice(0, 4)",
    "回滚失败信息只列前 4 条，前面已经给出 failed 总数",
  ],
]);

function sourceFiles(root: string): string[] {
  const absolute = join(process.cwd(), root);
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/u.test(entry)) found.push(path);
    }
  };
  walk(absolute);
  return found;
}

function truncations() {
  const found: { key: string; file: string; line: number }[] = [];
  for (const root of ROOTS) {
    for (const path of sourceFiles(root)) {
      const file = relative(process.cwd(), path).split(sep).join("/");
      readFileSync(path, "utf8")
        .split(/\r?\n/u)
        .forEach((text, index) => {
          if (!/\.slice\(\s*0\s*,\s*\d+\s*\)/u.test(text)) return;
          found.push({ key: `${file}|${text.trim()}`, file, line: index + 1 });
        });
    }
  }
  return found;
}

describe("列表不许被写死的条数截断", () => {
  it("生产代码里的每一处 .slice(0, N) 都得是在夹字符串，不是在砍列表", () => {
    const unexpected = truncations()
      .filter((item) => !STRING_CLAMPS.has(item.key))
      .map((item) => `${item.file}:${item.line}`);

    expect(
      unexpected,
      "要限高就让列表自己滚（.atm-scroll-list），不要砍掉后面几条：卡头的条数会和看得见的对不上。确实是在夹字符串的话，把它登记进 STRING_CLAMPS 并写清理由。",
    ).toEqual([]);
  });

  it("登记表里不留过期条目", () => {
    const present = new Set(truncations().map((item) => item.key));
    expect([...STRING_CLAMPS.keys()].filter((key) => !present.has(key))).toEqual([]);
  });

  it("侧栏列出全部活动项目", () => {
    const source = readFileSync(
      join(process.cwd(), "packages", "ui", "src", "shell", "sidebar.tsx"),
      "utf8",
    );
    // 列表本来就是滚动的，容不下的时候滚，不是少画几个。
    expect(source).toContain('.filter((project) => project.lifecycle === "ACTIVE")');
    expect(source).not.toMatch(/\.slice\(/u);
  });
});
