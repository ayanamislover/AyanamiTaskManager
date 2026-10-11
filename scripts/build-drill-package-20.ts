/**
 * install-drill 的 2.x ⇄ 3.0 场景要一份 2.0 时代 drill 构建的包（setup 带沙箱与故障注入；
 * 生产 2.0 的 setup 没有沙箱，不能用）。它不进仓库，由这里从 2.0.0 的提交打出来：
 *
 *   pnpm exec tsx scripts/build-drill-package-20.ts           # 已有且版本对就不重打
 *   pnpm exec tsx scripts/build-drill-package-20.ts --force   # 重打
 *   pnpm exec tsx scripts/build-drill-package-20.ts --out output/drill/x
 *
 * 2.0 的检出是 output/drill/src-<版本> 下的临时 git worktree：装依赖、打包、复制三个文件，
 * 然后连同 node_modules 一起移除，不留在磁盘上。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { LEGACY_VERSION } from "./version-sites.js";

/** 2.0.0 发布时 main 的提交（仓库里没有 v2.0.0 标签）。 */
export const RELEASE_20_COMMIT = "f4ea4ee5ac17b1916b9c1fe4e842f5bf58fbb4f6";

export function package20Files(version: string = LEGACY_VERSION): string[] {
  return ["atm-setup.exe", `atm-${version}-win-x64.json`, `atm-${version}-win-x64.zip`];
}

/** 已有的包能不能直接用：三个文件都在，清单的版本就是 2.0 的那个号。 */
export function package20Ready(outDir: string, version: string = LEGACY_VERSION): boolean {
  if (!package20Files(version).every((name) => existsSync(join(outDir, name)))) return false;
  try {
    const manifest = JSON.parse(
      readFileSync(join(outDir, `atm-${version}-win-x64.json`), "utf8"),
    ) as { version?: unknown };
    return manifest.version === version;
  } catch {
    return false;
  }
}

/** 包与临时检出都只能落在本仓库的 output/ 下（install-drill 只读那里，清理也只清那里）。 */
export function assertUnderOutput(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (!absolute.toLowerCase().startsWith(`${join(resolve(root), "output").toLowerCase()}${sep}`))
    throw new Error(`DRILL_PACKAGE_OUTSIDE_OUTPUT: ${absolute}`);
  return absolute;
}

function run(command: string, args: string[], cwd: string): void {
  process.stdout.write(`> ${command} ${args.join(" ")}  (${cwd})\n`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32" && command === "pnpm",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`DRILL_PACKAGE_STEP_FAILED: ${command} ${args[0] ?? ""} → ${result.status}`);
}

/** 摘掉临时检出：先让 git 注销它，注销不了（目录不是登记过的 worktree）就直接删目录再 prune。 */
function removeSource(root: string, source: string): void {
  spawnSync("git", ["worktree", "remove", "--force", source], { cwd: root, windowsHide: true });
  rmSync(source, { recursive: true, force: true });
  spawnSync("git", ["worktree", "prune"], { cwd: root, windowsHide: true });
  if (existsSync(source)) throw new Error(`DRILL_PACKAGE_SOURCE_LEFT: ${source}`);
}

function hasCommit(root: string, commit: string): boolean {
  return (
    spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root, windowsHide: true })
      .status === 0
  );
}

export function buildDrillPackage20(input: { root: string; outDir: string; force: boolean }): {
  built: boolean;
  outDir: string;
} {
  const root = resolve(input.root);
  const outDir = assertUnderOutput(root, input.outDir);
  if (!input.force && package20Ready(outDir)) return { built: false, outDir };

  // CI 的检出是浅的：2.0 的提交不在本地就单独取它一个。
  if (!hasCommit(root, RELEASE_20_COMMIT))
    run("git", ["fetch", "--no-tags", "--depth", "1", "origin", RELEASE_20_COMMIT], root);
  const source = assertUnderOutput(root, join("output", "drill", `src-${LEGACY_VERSION}`));
  // 上一次中途失败留下的检出先摘掉，再从干净的提交开始。
  removeSource(root, source);
  run("git", ["worktree", "add", "--detach", source, RELEASE_20_COMMIT], root);
  try {
    const declared = (
      JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { version: string }
    ).version;
    if (declared !== LEGACY_VERSION)
      throw new Error(`DRILL_PACKAGE_SOURCE_VERSION: ${declared} ≠ ${LEGACY_VERSION}`);
    run("pnpm", ["install", "--frozen-lockfile"], source);
    // 2.0 的两个 Rust 工作区各自钉了工具链；rustup 不再自动安装，先装上。不许顺手自更新：
    // 那会改调用者机器上的 rustup，而且替换 rustup.exe 的同时再调它会 EBUSY（W8d-5 实测）。
    run(
      "rustup",
      ["toolchain", "install", "--no-self-update"],
      join(source, "apps", "desktop", "native", "mcp-shim"),
    );
    run(
      "rustup",
      ["toolchain", "install", "--no-self-update"],
      join(source, "apps", "desktop", "native"),
    );
    const built = join("output", "drill", `package-${LEGACY_VERSION}`);
    run(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/package-native.ts", "--drill", built],
      source,
    );
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (const name of package20Files())
      copyFileSync(join(source, built, name), join(outDir, name));
    if (!package20Ready(outDir)) throw new Error(`DRILL_PACKAGE_INCOMPLETE: ${outDir}`);
  } finally {
    removeSource(root, source);
  }
  return { built: true, outDir };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const out = args.includes("--out")
    ? (args[args.indexOf("--out") + 1] ?? "")
    : join("output", "drill", `package-${LEGACY_VERSION}`);
  const result = buildDrillPackage20({
    root: process.cwd(),
    outDir: out,
    force: args.includes("--force"),
  });
  process.stdout.write(`${result.built ? "built" : "already present"}: ${result.outDir}\n`);
}
