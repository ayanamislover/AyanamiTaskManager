import { existsSync, rmSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

// 「产品装在哪、快捷方式落在哪」只能有一份认知。发布脚本负责卸载后清理，
// distribution-smoke 负责在验收前断言干净——两边各存一份清单，就会出现清理漏了
// 一处、验收却查得到的情况：1.0.5 那次 Squirrel 静默卸载留下开始菜单快捷方式，
// 发布链跑完九个阶段才在第十阶段的前置条件上倒掉。
export function productShortcutRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.APPDATA ? resolve(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs") : null,
    env.USERPROFILE ? resolve(env.USERPROFILE, "Desktop") : null,
  ].filter((path): path is string => path !== null);
}

async function filesBelow(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(path)));
    else result.push(path);
  }
  return result;
}

export async function findProductShortcuts(
  roots: string[] = productShortcutRoots(),
): Promise<string[]> {
  const found = (await Promise.all(roots.map(async (root) => await filesBelow(root)))).flat();
  return found.filter(
    (path) =>
      path.toLowerCase().endsWith(".lnk") &&
      basename(path).toLowerCase().includes("ayanamitaskmanager"),
  );
}

export async function removeProductShortcuts(
  roots: string[] = productShortcutRoots(),
): Promise<string[]> {
  const shortcuts = await findProductShortcuts(roots);
  for (const shortcut of shortcuts) await rm(shortcut, { force: true });
  return shortcuts;
}

/**
 * Squirrel 卸载时在安装根写下 .dead，告诉启动壳「这个应用已经没了」。
 * distribution-smoke 会走一整轮装—验—卸，于是留下这个标记；紧接着的就地更新
 * 把 app-<version> 铺回来，却不会清掉它。结果是一个「已卸载」标记贴在活着的
 * 安装上——下一轮走快速路径时，Update.exe 要对着这个自相矛盾的状态跑。
 *
 * 只在确实有对应版本目录时清除：没有 app-<version> 的话，.dead 是准确的。
 */
export function clearStaleDeadMarker(installRoot: string, version: string): boolean {
  const marker = join(installRoot, ".dead");
  if (!existsSync(marker) || !existsSync(join(installRoot, `app-${version}`))) return false;
  rmSync(marker, { force: true });
  return true;
}

// 删目录之前先证明它确实是安装目录。路径来自环境变量，环境变量出错时
// rm -rf 的代价和拼错的路径一样大。
export function assertSafeInstallRoot(installRoot: string, localAppDataRoot: string): void {
  if (
    basename(installRoot) !== "AyanamiTaskManagerDesktop" ||
    dirname(installRoot).toLowerCase() !== resolve(localAppDataRoot).toLowerCase()
  ) {
    throw new Error(`拒绝清理未验证的安装目录：${installRoot}`);
  }
}
