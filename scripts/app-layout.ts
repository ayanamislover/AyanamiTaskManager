import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 一个版本目录（`app-x.y.z`）的布局，de-electron §3。打包与 core 进程集成测试共用这一份，
 * 免得测试里的布局和真正发出去的不是一回事。
 *
 *   AyanamiTaskManager.exe            宿主（Rust）
 *   launcher\AyanamiTaskManager.exe   根启动器（FENCE 时由 setup 拷到安装根）
 *   atm-setup.exe                     安装器（同上；也是「ATM 修复」的后备入口）
 *   runtime\atm-core.exe              改名的 node.exe
 *   runtime\core.mjs、cli.mjs         esbuild 单文件
 *   runtime\node_modules\better-sqlite3\{package.json,lib\,prebuilds\win32-x64.node}
 *   resources\ATM_AGENT_GUIDE.md、docs\、integrations\、mcp-stdio.cjs、atm-mcp.exe
 *   renderer\                         Vite 构建产物
 *   migrations\
 */
export const APP_LAYOUT = {
  host: "AyanamiTaskManager.exe",
  launcher: join("launcher", "AyanamiTaskManager.exe"),
  setup: "atm-setup.exe",
  coreExe: join("runtime", "atm-core.exe"),
  coreBundle: join("runtime", "core.mjs"),
  cliBundle: join("runtime", "cli.mjs"),
  sqlitePackage: join("runtime", "node_modules", "better-sqlite3"),
  resources: "resources",
  renderer: "renderer",
  migrations: "migrations",
} as const;

export type AppLayoutInput = {
  root: string;
  target: string;
  hostExe: string;
  nodeExe: string;
  /** 不传则不放 shim（开发机没有 cargo 构建产物时的集成测试）。 */
  mcpShimExe?: string;
  /** 不传则不放 renderer（只测 core 时）。 */
  rendererDir?: string;
  /** 打包时盖过构建戳的 Guide 文本；不传用源文件。 */
  stampedGuide?: string;
  /** core.mjs/cli.mjs 所在目录；默认 apps/desktop/dist/core（演练的第二版本另建）。 */
  coreDir?: string;
  /** 根启动器与安装器；只测 core 时不需要。 */
  launcherExe?: string;
  setupExe?: string;
};

function betterSqlitePackage(root: string): string {
  const hoisted = join(root, "node_modules", "better-sqlite3");
  if (existsSync(join(hoisted, "package.json"))) return hoisted;
  throw new Error("BETTER_SQLITE3_MISSING: 先 pnpm install");
}

export function assembleAppDirectory(input: AppLayoutInput): string {
  const root = resolve(input.root);
  const target = resolve(input.target);
  const at = (path: string) => join(target, path);
  mkdirSync(at("runtime"), { recursive: true });
  copyFileSync(input.hostExe, at(APP_LAYOUT.host));
  copyFileSync(input.nodeExe, at(APP_LAYOUT.coreExe));
  const coreDist = input.coreDir ?? join(root, "apps", "desktop", "dist", "core");
  copyFileSync(join(coreDist, "core.mjs"), at(APP_LAYOUT.coreBundle));
  copyFileSync(join(coreDist, "cli.mjs"), at(APP_LAYOUT.cliBundle));

  const sqlite = betterSqlitePackage(root);
  const sqliteTarget = at(APP_LAYOUT.sqlitePackage);
  mkdirSync(join(sqliteTarget, "prebuilds"), { recursive: true });
  copyFileSync(join(sqlite, "package.json"), join(sqliteTarget, "package.json"));
  copyFileSync(join(sqlite, "LICENSE"), join(sqliteTarget, "LICENSE"));
  cpSync(join(sqlite, "lib"), join(sqliteTarget, "lib"), { recursive: true });
  copyFileSync(
    join(sqlite, "prebuilds", "win32-x64.node"),
    join(sqliteTarget, "prebuilds", "win32-x64.node"),
  );

  const resources = at(APP_LAYOUT.resources);
  mkdirSync(resources, { recursive: true });
  if (input.stampedGuide === undefined)
    copyFileSync(join(root, "ATM_AGENT_GUIDE.md"), join(resources, "ATM_AGENT_GUIDE.md"));
  else writeFileSync(join(resources, "ATM_AGENT_GUIDE.md"), input.stampedGuide, "utf8");
  cpSync(join(root, "docs"), join(resources, "docs"), { recursive: true });
  cpSync(join(root, "integrations"), join(resources, "integrations"), { recursive: true });
  copyFileSync(
    join(root, "apps", "desktop", "resources", "mcp-stdio.cjs"),
    join(resources, "mcp-stdio.cjs"),
  );
  if (input.mcpShimExe) copyFileSync(input.mcpShimExe, join(resources, "atm-mcp.exe"));
  if (input.rendererDir) cpSync(input.rendererDir, at(APP_LAYOUT.renderer), { recursive: true });
  cpSync(join(root, "migrations"), at(APP_LAYOUT.migrations), { recursive: true });
  if (input.launcherExe) {
    mkdirSync(dirname(at(APP_LAYOUT.launcher)), { recursive: true });
    copyFileSync(input.launcherExe, at(APP_LAYOUT.launcher));
  }
  if (input.setupExe) copyFileSync(input.setupExe, at(APP_LAYOUT.setup));
  return target;
}
