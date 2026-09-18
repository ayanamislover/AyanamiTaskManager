import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// atm-notice 是右下角的全局浮层提示条（position: fixed、z-index 30），只该由 app-shell
// 用 Presence 挂一次。页面自己拿这个类画页内提示，结果就是一条警告浮在卡片上面
// （Agent 页的冲突警告就是这样），或者和全局提示叠在同一个角落、永不消失（设置页）。

const sourceRoot = join(process.cwd(), "packages", "ui", "src");
const host = join("packages", "ui", "src", "shell", "app-shell.tsx");

export function noticeClassUsers(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([file, source]) => file !== host && /["'`\s]atm-notice["'`\s]/u.test(source))
    .map(([file]) => file);
}

function sources(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".tsx"))
        files[relative(process.cwd(), path)] = readFileSync(path, "utf8");
    }
  };
  walk(sourceRoot);
  return files;
}

describe("全局提示条只有一个宿主", () => {
  it("除 app-shell 外没有组件直接使用 atm-notice", () => {
    const files = sources();
    expect(Object.keys(files)).toContain(host);
    expect(files[host]).toContain('className="atm-notice"');
    expect(noticeClassUsers(files)).toEqual([]);
  });

  it("阳性对照：页面组件里的 atm-notice 会被抓到，相似类名不误报", () => {
    expect(
      noticeClassUsers({
        [host]: '<div className="atm-notice" role="status" />',
        "packages/ui/src/features/page.tsx": '<div className="atm-notice" role="status" />',
        "packages/ui/src/features/mixed.tsx": "<div className={`atm-notice ${tone}`} />",
        "packages/ui/src/features/ok.tsx":
          '<div className="atm-notice-lifecycle atm-inline-warning" />',
      }),
    ).toEqual(["packages/ui/src/features/page.tsx", "packages/ui/src/features/mixed.tsx"]);
  });
});
