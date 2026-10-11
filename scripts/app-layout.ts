import { copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 一个版本目录（`app-x.y.z`）的布局，de-electron §3；3.0 起是单进程，不带 Node（W8a）。
 * 打包与测试共用这一份，免得测试里的布局和真正发出去的不是一回事。
 *
 *   AyanamiTaskManager.exe            宿主（Rust）：窗口、托盘与进程内的 ATM 3 服务
 *   LICENSE                           本项目许可证（AGPL-3.0）
 *   launcher\AyanamiTaskManager.exe   根启动器（FENCE 时由 setup 拷到安装根）
 *   atm-setup.exe                     安装器（同上；也是「ATM 修复」的后备入口）
 *   resources\atm.exe                 命令行（宿主的 --cli / --doctor 交给它；也是打包布局的标记）
 *   resources\atm-mcp.exe             MCP stdio 桥
 *   resources\ATM_AGENT_GUIDE.md、docs\、integrations\
 *   renderer\                         Vite 构建产物
 *
 * 迁移 SQL 编译进了二进制（3.0 的库与 2.x 转换器认得的那一套），版本目录里没有 migrations\。
 */
export const APP_LAYOUT = {
  host: "AyanamiTaskManager.exe",
  launcher: join("launcher", "AyanamiTaskManager.exe"),
  setup: "atm-setup.exe",
  cli: join("resources", "atm.exe"),
  mcpShim: join("resources", "atm-mcp.exe"),
  resources: "resources",
  renderer: "renderer",
} as const;

export type AppLayoutInput = {
  root: string;
  target: string;
  hostExe: string;
  /** 不传则不放 atm.exe（只测 Guide 盖戳等不需要可执行文件的场合）。 */
  cliExe?: string;
  /** 不传则不放 shim。 */
  mcpShimExe?: string;
  /** 不传则不放 renderer。 */
  rendererDir?: string;
  /** 打包时盖过构建戳的 Guide 文本；不传用源文件。 */
  stampedGuide?: string;
  /** 根启动器与安装器。 */
  launcherExe?: string;
  setupExe?: string;
};

export function assembleAppDirectory(input: AppLayoutInput): string {
  const root = resolve(input.root);
  const target = resolve(input.target);
  const at = (path: string) => join(target, path);
  mkdirSync(target, { recursive: true });
  copyFileSync(input.hostExe, at(APP_LAYOUT.host));
  // AGPL：二进制分发要带许可证全文。
  copyFileSync(join(root, "LICENSE"), at("LICENSE"));

  const resources = at(APP_LAYOUT.resources);
  mkdirSync(resources, { recursive: true });
  if (input.stampedGuide === undefined)
    copyFileSync(join(root, "ATM_AGENT_GUIDE.md"), join(resources, "ATM_AGENT_GUIDE.md"));
  else writeFileSync(join(resources, "ATM_AGENT_GUIDE.md"), input.stampedGuide, "utf8");
  cpSync(join(root, "docs"), join(resources, "docs"), { recursive: true });
  cpSync(join(root, "integrations"), join(resources, "integrations"), { recursive: true });
  if (input.cliExe) copyFileSync(input.cliExe, at(APP_LAYOUT.cli));
  if (input.mcpShimExe) copyFileSync(input.mcpShimExe, at(APP_LAYOUT.mcpShim));
  if (input.rendererDir) cpSync(input.rendererDir, at(APP_LAYOUT.renderer), { recursive: true });
  if (input.launcherExe) {
    mkdirSync(dirname(at(APP_LAYOUT.launcher)), { recursive: true });
    copyFileSync(input.launcherExe, at(APP_LAYOUT.launcher));
  }
  if (input.setupExe) copyFileSync(input.setupExe, at(APP_LAYOUT.setup));
  return target;
}
