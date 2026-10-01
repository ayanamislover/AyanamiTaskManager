import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// 手机同步像 RustDesk 一样由用户自己配置中继（docs/mobile-sync.md、ADR-017）。
// 开源仓库与安装包里不许出现维护者自己的服务器地址——哪怕只是默认值或示例。
// 维护者联系邮箱（ay@nami.ltd）不是服务器地址，不在拦截范围内。

const FORBIDDEN_HOST = /(?:\/\/|[a-z0-9-]\.)nami\.ltd|alayanami\.com/iu;

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".xml",
  ".gradle",
  ".properties",
  ".html",
  ".css",
  ".java",
  ".kt",
  ".ps1",
  ".sh",
  ".toml",
  // 原生宿主（de-electron）是生产代码。
  ".rs",
]);

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".claude",
  ".local",
  ".gradle",
  ".idea",
  ".vite",
  "build",
  "dist",
  "out",
  "release",
  "output",
  "coverage",
  "test-results",
  "playwright-report",
  // Rust 构建产物（apps/desktop/native/target*）。
  "target",
  "target-drill",
  "target-smoke",
]);

export function findForbiddenHosts(
  files: Array<{ path: string; source: string }>,
): Array<{ path: string; line: number; text: string }> {
  const hits: Array<{ path: string; line: number; text: string }> = [];
  for (const file of files) {
    file.source.split(/\r?\n/u).forEach((text, index) => {
      if (FORBIDDEN_HOST.test(text))
        hits.push({ path: file.path, line: index + 1, text: text.trim() });
    });
  }
  return hits;
}

function collectTextFiles(
  root: string,
  directory: string,
  out: Array<{ path: string; source: string }>,
) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) collectTextFiles(root, path, out);
      continue;
    }
    if (!entry.isFile() || !TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    out.push({
      path: relative(root, path).replaceAll("\\", "/"),
      source: readFileSync(path, "utf8"),
    });
  }
}

describe("不内置任何中继服务器", () => {
  it("仓库里的代码、配置与文档不含维护者的服务器地址", () => {
    const root = process.cwd();
    const files: Array<{ path: string; source: string }> = [];
    for (const top of ["apps", "packages", "integrations", "scripts", "docs"]) {
      collectTextFiles(root, join(root, top), files);
    }
    for (const single of ["README.md", "ATM_AGENT_GUIDE.md", "package.json"]) {
      files.push({ path: single, source: readFileSync(join(root, single), "utf8") });
    }
    expect(files.length).toBeGreaterThan(200);
    const self = "packages/testing/test/no-default-relay-server.test.ts";
    expect(findForbiddenHosts(files.filter((file) => file.path !== self))).toEqual([]);
  });

  it("阳性对照：服务器地址会被拦下，联系邮箱不会", () => {
    const fixtures = [
      { path: "a.ts", source: 'const relay = "https://cloud.nami.ltd";' },
      { path: "b.xml", source: "<domain>cloud-ams.nami.ltd</domain>" },
      { path: "c.md", source: "服务器 https://nami.ltd/relay" },
      { path: "d.ts", source: "wss://x.alayanami.com/ws" },
      { path: "e.md", source: "联系 [ay@nami.ltd](mailto:ay@nami.ltd)" },
    ];
    expect(findForbiddenHosts(fixtures).map((hit) => hit.path)).toEqual([
      "a.ts",
      "b.xml",
      "c.md",
      "d.ts",
    ]);
  });
});
