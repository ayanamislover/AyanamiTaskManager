import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * core 在哪个版本目录里运行，由 core 自己的 bundle 位置推导，不信宿主握手自报。
 *
 * 打包布局（de-electron §3）：
 *   <appDir>\AyanamiTaskManager.exe      宿主
 *   <appDir>\runtime\atm-core.exe        改名的 node.exe
 *   <appDir>\runtime\core.mjs            本 bundle
 *   <appDir>\resources\                  shim、mcp-stdio.cjs、Guide/docs/integrations
 *   <appDir>\migrations\
 */
export type CorePaths = {
  packaged: boolean;
  appDir: string;
  hostPath: string;
  resourcesRoot: string;
  migrationsRoot: string;
  /** installAgentDocumentation 的 bundled 根：Guide、docs/、integrations/skills。 */
  documentationRoot: string;
  mcpStdioSource: string;
};

export function packagedCorePaths(bundleFile: string): CorePaths {
  const appDir = resolve(dirname(bundleFile), "..");
  const resourcesRoot = join(appDir, "resources");
  return {
    packaged: true,
    appDir,
    hostPath: join(appDir, "AyanamiTaskManager.exe"),
    resourcesRoot,
    migrationsRoot: join(appDir, "migrations"),
    documentationRoot: resourcesRoot,
    mcpStdioSource: join(resourcesRoot, "mcp-stdio.cjs"),
  };
}

/** 源码运行（tsx）：仓库根即应用根，宿主是本地 cargo 构建的产物。 */
export function sourceCorePaths(repositoryRoot: string, hostPath: string): CorePaths {
  return {
    packaged: false,
    appDir: repositoryRoot,
    hostPath,
    resourcesRoot: join(repositoryRoot, "apps", "desktop", "resources"),
    migrationsRoot: join(repositoryRoot, "migrations"),
    documentationRoot: repositoryRoot,
    mcpStdioSource: join(repositoryRoot, "apps", "desktop", "resources", "mcp-stdio.cjs"),
  };
}

/** 打包布局是否完整：宿主 exe 必须和 bundle 在约定的相对位置上。 */
export function packagedLayoutPresent(paths: CorePaths): boolean {
  return existsSync(paths.hostPath) && existsSync(paths.migrationsRoot);
}
