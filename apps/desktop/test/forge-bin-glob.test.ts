import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * ATM-T-0488：@electron-forge/core 7.11.2 在 afterCopy 里用
 * `fastGlob(path.join(buildPath, "**\/.bin/**\/*"))` 删包内的 .bin。Windows 上 path.join 产生反斜杠，
 * fast-glob 把反斜杠当转义符，pattern 丢了绝对前缀，于是从 process.cwd()——也就是仓库根——
 * 开始遍历整个仓库。output/ 下烟测留下的合成 HOME 里只要有一个暂时不可列的目录
 * （INetCache\Content.IE5），打包就 EPERM scandir 失败。
 *
 * 修法是 patches/@electron-forge__core@7.11.2.patch：pattern 改成相对的，cwd 设为 buildPath。
 */
const ROOT = process.cwd();
const localRequire = createRequire(import.meta.url);
const forgeRequire = createRequire(localRequire.resolve("@electron-forge/core/package.json"));
const fastGlob = forgeRequire("fast-glob") as (
  pattern: string,
  options?: { cwd?: string; absolute?: boolean; fs?: Record<string, unknown> },
) => Promise<string[]>;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * 记录 fast-glob 列过哪些目录。@nodelib/fs.scandir 在模块加载时就把 fs.readdir 存起来了，
 * 事后给 fs 打桩拦不到（`walked` 会永远是空集，断言空转），所以走 fast-glob 自己的 fs 选项。
 */
function recordingFs(): { walked: Set<string>; adapter: Record<string, unknown> } {
  const walked = new Set<string>();
  const adapter = {
    lstat: fs.lstat,
    stat: fs.stat,
    lstatSync: fs.lstatSync,
    statSync: fs.statSync,
    readdir: (path: string, ...rest: unknown[]) => {
      walked.add(resolve(path));
      return (fs.readdir as (...args: unknown[]) => unknown)(path, ...rest);
    },
    readdirSync: (path: string, ...rest: unknown[]) => {
      walked.add(resolve(path));
      return (fs.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
    },
  };
  return { walked, adapter };
}

function fixture(): { buildPath: string; fakeCwd: string } {
  const root = mkdtempSync(join(tmpdir(), "atm-forge-bin-glob-"));
  roots.push(root);
  const buildPath = join(root, "staging", "resources", "app");
  mkdirSync(join(buildPath, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(buildPath, "node_modules", ".bin", "tool.cmd"), "");
  // 充当仓库根：遍历若跑到这里，就是事故里扫进 output/ 的那条路。
  const fakeCwd = join(root, "repo");
  mkdirSync(join(fakeCwd, "output", "packaged-smoke-agent-config-x", "Home"), { recursive: true });
  return { buildPath, fakeCwd };
}

describe("forge 删除包内 .bin 的 glob", () => {
  it("补丁已声明、确实装上，且对得上当前 forge 版本", () => {
    const version = (
      JSON.parse(
        readFileSync(forgeRequire.resolve("@electron-forge/core/package.json"), "utf8"),
      ) as { version: string }
    ).version;
    const workspace = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
    // pnpm patch-commit 写单引号，prettier 改成双引号，两种都认。
    const escaped = version.replaceAll(".", "\\.");
    expect(workspace).toMatch(
      new RegExp(
        `["']@electron-forge/core@${escaped}["']: patches/@electron-forge__core@${escaped}\\.patch`,
        "u",
      ),
    );
    const installed = readFileSync(
      forgeRequire.resolve("@electron-forge/core/dist/api/package.js"),
      "utf8",
    );
    expect(installed).toContain(
      "(0, fast_glob_1.default)('**/.bin/**/*', { cwd: buildPath, absolute: true })",
    );
    expect(installed).not.toMatch(/fast_glob_1\.default\)\(node_path_1\.default\.join\(/u);
  });

  it("补丁后的写法只在 buildPath 里找，并且照样找到 .bin", async () => {
    const { buildPath, fakeCwd } = fixture();
    const { walked, adapter } = recordingFs();
    const bins = await fastGlob("**/.bin/**/*", { cwd: buildPath, absolute: true, fs: adapter });
    expect(bins.map((bin) => resolve(bin))).toEqual([
      join(buildPath, "node_modules", ".bin", "tool.cmd"),
    ]);
    expect(walked.has(join(buildPath, "node_modules"))).toBe(true);
    expect([...walked].filter((dir) => !`${dir}${sep}`.startsWith(`${buildPath}${sep}`))).toEqual(
      [],
    );
    expect([...walked].some((dir) => dir.startsWith(fakeCwd))).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "阳性对照：原写法在 Windows 上一个 .bin 都找不到，却遍历了 cwd",
    async () => {
      const { buildPath, fakeCwd } = fixture();
      const { walked, adapter } = recordingFs();
      // forge 原调用不传 cwd，等价于 cwd = process.cwd()；这里把它指到假仓库根。
      const bins = await fastGlob(join(buildPath, "**/.bin/**/*"), { cwd: fakeCwd, fs: adapter });
      expect(bins).toEqual([]);
      expect(walked.has(join(fakeCwd, "output", "packaged-smoke-agent-config-x"))).toBe(true);
    },
  );
});
