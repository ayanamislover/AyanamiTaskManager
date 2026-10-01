import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const repositoryRoot = process.cwd();
export const uiSourceRoot = join(repositoryRoot, "packages", "ui", "src");
export const uiStylesEntry = join(uiSourceRoot, "styles.css");

export function cssImportTargets(source: string): string[] {
  return [...source.matchAll(/@import\s+["']([^"']+)["']\s*;/gu)].map((match) => match[1]!);
}

export function cssEntryBody(source: string): string {
  return source.replace(/@import\s+["'][^"']+["']\s*;/gu, "").trim();
}

export function readCssImportGraph(entry = uiStylesEntry): string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (path: string) => {
    const absolute = resolve(path);
    if (visiting.has(absolute)) throw new Error(`CSS import cycle: ${absolute}`);
    if (visited.has(absolute)) return;
    visiting.add(absolute);
    visited.add(absolute);
    ordered.push(absolute);
    const source = readFileSync(absolute, "utf8");
    for (const target of cssImportTargets(source)) {
      if (!target.startsWith(".")) throw new Error(`External CSS import is not allowed: ${target}`);
      visit(resolve(dirname(absolute), target));
    }
    visiting.delete(absolute);
  };
  visit(entry);
  return ordered;
}

export function uiCssText(): string {
  return readCssImportGraph()
    .slice(1)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

export function uiComponentCssText(): string {
  return readCssImportGraph()
    .slice(1)
    .filter((path) => path !== join(uiSourceRoot, "tokens.css"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

export function recursiveFiles(directory: string, extension: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return recursiveFiles(path, extension);
    return entry.isFile() && entry.name.endsWith(extension) ? [path] : [];
  });
}

export function productionFiles(extension: string): string[] {
  return ["apps", "packages"].flatMap((container) => {
    const containerPath = join(repositoryRoot, container);
    return readdirSync(containerPath, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const sourcePath = join(containerPath, entry.name, "src");
      return existsSync(sourcePath) ? recursiveFiles(sourcePath, extension) : [];
    });
  });
}

export function productionCssText(): string {
  return productionFiles(".css")
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

export function relativeToRepository(path: string): string {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

/* ─── 手机端（apps/mobile） ───
 * 手机端没有 CSS 入口文件：样式由 main.tsx 逐条 side-effect import，这串 import 的顺序就是 cascade 顺序。
 * 守卫按同一顺序读，跨文件比较「同特指度谁在后」才有意义。 */
export const mobileAppRoot = join(repositoryRoot, "apps", "mobile");
export const mobileSourceRoot = join(mobileAppRoot, "src");
export const mobileEntry = join(mobileSourceRoot, "main.tsx");

/** main.tsx（或任意 TS 源码）里 side-effect 引入的 CSS，按出现顺序。 */
export function moduleCssImports(source: string): string[] {
  return [...source.matchAll(/^\s*import\s+["']([^"']+\.css)["']\s*;/gmu)].map(
    (match) => match[1]!,
  );
}

/** 解析手机端引入的 CSS 说明符：相对路径，或经 package.json exports 指向的工作区包样式。 */
export function resolveMobileCssImport(fromFile: string, specifier: string): string {
  if (specifier.startsWith(".")) return resolve(dirname(fromFile), specifier);
  const workspace = /^@ayanami-task\/([\w-]+)\/(.+)$/u.exec(specifier);
  if (!workspace) throw new Error(`手机端不允许引入外部 CSS：${specifier}`);
  const packageRoot = join(repositoryRoot, "packages", workspace[1]!);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const target = manifest.exports?.[`./${workspace[2]!}`];
  if (typeof target !== "string") throw new Error(`${specifier} 不在包的 exports 里`);
  return resolve(packageRoot, target);
}

/** 手机端全部生效 CSS，按 cascade 顺序（含被引入 CSS 里的 @import）。 */
export function readMobileCssGraph(
  entry = mobileEntry,
  entrySource = readFileSync(entry, "utf8"),
): string[] {
  const ordered: string[] = [];
  for (const specifier of moduleCssImports(entrySource)) {
    for (const path of readCssImportGraph(resolveMobileCssImport(entry, specifier))) {
      if (!ordered.includes(path)) ordered.push(path);
    }
  }
  return ordered;
}

export type CssSourceFile = { readonly path: string; readonly text: string };

export function mobileCssSources(): CssSourceFile[] {
  return readMobileCssGraph().map((path) => ({
    path: relativeToRepository(path),
    text: readFileSync(path, "utf8"),
  }));
}

/** 手机端生产源码：src 下全部 TS/TSX/HTML，外加不在 src 里的页面入口 index.html。 */
export function mobileProductionSources(): string[] {
  return [
    ...[".ts", ".tsx", ".html"].flatMap((extension) => recursiveFiles(mobileSourceRoot, extension)),
    join(mobileAppRoot, "index.html"),
  ];
}
