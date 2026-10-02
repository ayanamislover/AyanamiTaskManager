import { existsSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
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

type DirectoryEntryLike = {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

type DirectoryReader = (directory: string) => Promise<DirectoryEntryLike[]>;

const readDirectory: DirectoryReader = async (directory) =>
  readdir(directory, { withFileTypes: true });

export async function walkProductFiles(
  directory: string,
  readEntries: DirectoryReader = readDirectory,
): Promise<string[]> {
  const result: string[] = [];
  const pending = [directory];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    const identity = resolve(current).toLowerCase();
    if (visited.has(identity)) continue;
    visited.add(identity);
    let entries: DirectoryEntryLike[];
    try {
      entries = await readEntries(current);
    } catch {
      // 开始菜单可能包含已失效或无权访问的系统目录；它们与本产品快捷方式无关。
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      // junction / symlink 可能逃出扫描根或形成循环。快捷方式本身是普通 .lnk 文件，
      // 因此扫描时没有任何跟随 reparse point 的必要。
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(path);
      else result.push(path);
    }
  }
  return result;
}

export async function findProductShortcuts(
  roots: string[] = productShortcutRoots(),
): Promise<string[]> {
  const found = (await Promise.all(roots.map(async (root) => await walkProductFiles(root)))).flat();
  return found.filter(
    (path) =>
      path.toLowerCase().endsWith(".lnk") &&
      basename(path).toLowerCase().includes("ayanamitaskmanager"),
  );
}

/** PowerShell 单引号字面量：只有单引号要翻倍，反斜杠原样（JSON 的转义规则在这里是错的）。 */
export function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * 结束本安装根里 `resources\atm-mcp.exe` 的进程（各 Agent 会话的 stdio shim），输出被结束的 PID。
 *
 * 映像路径要精确相等，别处的 atm-mcp（便携版、另一份安装）不碰。先取进程句柄再核路径、再用
 * 同一个句柄结束：句柄开着，这个 PID 就不会被系统复用，「先枚举 PID、再 taskkill」之间换了
 * 进程的竞态也就没有了。
 */
export function stopInstalledShimsScript(installRoot: string): string {
  const image = join(installRoot, "resources", "atm-mcp.exe");
  return [
    `$image = ${powerShellLiteral(image)}`,
    "Get-Process -Name atm-mcp -ErrorAction SilentlyContinue | ForEach-Object {",
    "  try { $null = $_.Handle } catch { return }",
    "  if ($_.Path -and [string]::Equals($_.Path, $image, [StringComparison]::OrdinalIgnoreCase)) {",
    "    $_.Kill(); $_.Id",
    "  }",
    "}",
  ].join("\n");
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
