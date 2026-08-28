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
