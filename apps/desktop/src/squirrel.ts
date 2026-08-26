import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

export type UpdateRunnerResult = { ok: boolean; detail?: string };
export type UpdateRunner = (updateExe: string, args: string[]) => UpdateRunnerResult | void;

const defaultRunner: UpdateRunner = (updateExe, args) => {
  const result = spawnSync(updateExe, args, { windowsHide: true });
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0)
    return { ok: false, detail: `Update.exe exit ${result.status ?? "unknown"}` };
  return { ok: true };
};

/**
 * Squirrel 在安装、更新和卸载时会用 `--squirrel-*` 参数拉起应用本体，等它退出后
 * 才继续。Electron 应用带 Squirrel-aware 标记，Squirrel 因此把创建快捷方式的责任
 * 交给应用；应用不接管，两边就都不做——1.0.5 装完开始菜单里什么都没有正是如此。
 *
 * 这些事件下必须不开窗口、不起服务、迅速退出，否则 Squirrel 只能等到超时。
 * 返回 true 表示「这是一次 Squirrel 生命周期调用，调用方应立即退出」。
 */
// 只有这四个是「安装器在借用应用做事」，做完必须退出。
// 注意 --squirrel-firstrun 不在其中：那是安装完成后用户第一次点开应用，Squirrel
// 顺手加上的标记，此时必须正常启动。把它一起退掉，表现就是「装完点图标没反应」。
const LIFECYCLE_EVENTS = new Set([
  "--squirrel-install",
  "--squirrel-updated",
  "--squirrel-uninstall",
  "--squirrel-obsolete",
]);

export function handleSquirrelStartup(
  argv: string[],
  execPath: string,
  run: UpdateRunner = defaultRunner,
  onFailure?: (detail: string) => void,
): boolean {
  const event = argv[1];
  if (!event || !LIFECYCLE_EVENTS.has(event)) return false;
  // 安装目录布局是 <root>/app-<version>/App.exe 与 <root>/Update.exe。
  const updateExe = resolve(dirname(execPath), "..", "Update.exe");
  const target = basename(execPath);
  if (event === "--squirrel-install" || event === "--squirrel-updated") {
    const result = run(updateExe, ["--createShortcut", target]);
    if (result && !result.ok) onFailure?.(result.detail ?? "Update.exe failed");
  } else if (event === "--squirrel-uninstall") {
    const result = run(updateExe, ["--removeShortcut", target]);
    if (result && !result.ok) onFailure?.(result.detail ?? "Update.exe failed");
  }
  // --squirrel-obsolete 只需要安静退出。
  return true;
}
