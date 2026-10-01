import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// de-electron（ATM-T-0565）之后宿主是 Rust + WebView2，core 跑在随包的 node 上。
// Electron 一旦从某个角落被重新 import 回来，pnpm 会把 200 多 MB 的运行时装回来，
// 而功能测试照样全绿——所以由这条守卫把住：生产代码、脚本、依赖声明和锁文件里都不许再有它。

const root = process.cwd();

const sourceRoots = [
  ...["apps", "packages"].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => [
        join(root, group, entry.name, "src"),
        join(root, group, entry.name, "scripts"),
      ]),
  ),
  join(root, "scripts"),
  join(root, ".github", "scripts"),
].filter((directory) => existsSync(directory));

const patterns: Array<[string, RegExp]> = [
  ["import electron", /\bfrom\s+["']electron(?:\/[^"']*)?["']/gu],
  ["动态 import electron", /\bimport\s*\(\s*["']electron(?:\/[^"']*)?["']\s*\)/gu],
  ["require electron", /\brequire\s*\(\s*["']electron(?:\/[^"']*)?["']\s*\)/gu],
  ["Playwright 的 _electron", /\b_electron\b/gu],
  ["Electron 工具链", /["']@electron(?:-forge)?\/[^"']+["']/gu],
];

export function electronReferences(files: Record<string, string>): string[] {
  const hits: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    for (const [label, pattern] of patterns) {
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split("\n").length;
        hits.push(`${file}:${line} ${label}: ${match[0]}`);
      }
    }
  }
  return hits;
}

function sources(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(entry.name))
        files[relative(root, path).replaceAll("\\", "/")] = readFileSync(path, "utf8");
    }
  };
  for (const directory of sourceRoots) walk(directory);
  return files;
}

const electronPackage = /^(?:electron(?:-[\w-]+)?|@electron(?:-forge)?\/[\w.-]+)$/u;

function manifests(): string[] {
  return [
    "package.json",
    ...["apps", "packages"].flatMap((group) =>
      readdirSync(join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${group}/${entry.name}/package.json`)
        .filter((path) => existsSync(join(root, path))),
    ),
  ];
}

describe("Electron 已彻底移除", () => {
  it("匹配器认得出每一种把 Electron 带回来的写法（阳性对照）", () => {
    expect(
      electronReferences({
        "a.ts": 'import { app } from "electron";',
        "b.ts": 'const { ipcRenderer } = require("electron");',
        "c.ts": 'await import("electron/main");',
        "d.ts": 'import { _electron as electron } from "@playwright/test";',
        "e.ts": 'import { api } from "@electron-forge/core";',
        "f.ts": 'import asar from "@electron/asar";',
      }),
    ).toHaveLength(6);
    // 只是提到 Electron 的注释和标识符（迁移代码里很多）不算。
    expect(
      electronReferences({ "g.ts": "// 从 Electron 1.x 迁移\nconst electronLayout = true;" }),
    ).toEqual([]);
    for (const name of ["electron", "electron-winstaller", "@electron-forge/cli", "@electron/asar"])
      expect(name).toMatch(electronPackage);
  });

  it("生产代码、构建与发布脚本里没有任何 Electron 引用", () => {
    const files = sources();
    // 扫描面不能是空的，否则永远是绿的。
    expect(Object.keys(files).length).toBeGreaterThan(200);
    for (const expected of [
      "apps/desktop/src/core-main.ts",
      "scripts/package-native.ts",
      "packages/ui/src/app.tsx",
    ])
      expect(Object.keys(files)).toContain(expected);
    expect(electronReferences(files)).toEqual([]);
  });

  it("各 package.json 不声明 Electron 系依赖，也不再有 Electron 入口", () => {
    const declared: string[] = [];
    for (const path of manifests()) {
      const manifest = JSON.parse(readFileSync(join(root, path), "utf8")) as Record<
        string,
        unknown
      >;
      for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const dependencies = (manifest[field] ?? {}) as Record<string, string>;
        for (const name of Object.keys(dependencies))
          if (electronPackage.test(name)) declared.push(`${path} ${field}: ${name}`);
      }
      const scripts = (manifest.scripts ?? {}) as Record<string, string>;
      for (const [name, command] of Object.entries(scripts))
        if (/\belectron\b|forge-(?:make|package)/u.test(command))
          declared.push(`${path} scripts.${name}: ${command}`);
    }
    expect(manifests().length).toBeGreaterThan(10);
    expect(declared).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).not.toHaveProperty("main");
  });

  // 依赖声明删干净了、锁文件没重新生成，CI 的 frozen install 还是会把它装回来。
  it("锁文件里没有 Electron 运行时与打包工具链", () => {
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    const packages = [...lock.matchAll(/^ {2}'?((?:@[\w.-]+\/)?[\w.-]+)@[^:\s]+'?:/gmu)].map(
      (match) => match[1] ?? "",
    );
    expect(packages.length).toBeGreaterThan(100);
    expect(
      packages.filter((name) => electronPackage.test(name) && name !== "electron-to-chromium"),
    ).toEqual([]);
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).not.toMatch(/electron/iu);
  });
});
