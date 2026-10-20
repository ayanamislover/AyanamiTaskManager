import { relative, sep } from "node:path";

/**
 * renderer bundle 里实际打进去的 npm 包（3.0 起，包里唯一的 JavaScript 就是它）。
 *
 * Vite 构建时由 vite.config.ts 的插件把每个 chunk 的模块 id 交给这里，结果写到
 * `apps/desktop/dist/renderer-packages.json`（renderer 目录之外，不进包）；第三方声明
 * 按这份清单收 npm 组件——收的是进了包的，不是 package.json 里声明过的。
 */
export const RENDERER_PACKAGES_FILE = "renderer-packages.json";

export type RendererPackage = {
  name: string;
  /** 包目录，相对仓库根、用 `/`。 */
  dir: string;
};

/** 模块 id 里最后一段 `node_modules/<name>` 就是这个模块所属的包（pnpm 的 .pnpm 目录也是如此）。 */
export function packageOfModule(id: string): { name: string; dir: string } | null {
  const path = id.replace(/^\0+/u, "").replace(/\?.*$/su, "").replaceAll("\\", "/");
  const at = path.lastIndexOf("/node_modules/");
  if (at < 0) return null;
  const rest = path.slice(at + "/node_modules/".length).split("/");
  const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1] ?? ""}` : rest[0];
  if (!name || name.endsWith("/") || name.startsWith(".")) return null;
  return { name, dir: `${path.slice(0, at)}/node_modules/${name}` };
}

export function rendererPackages(moduleIds: Iterable<string>, root: string): RendererPackage[] {
  const found = new Map<string, RendererPackage>();
  for (const id of moduleIds) {
    const owner = packageOfModule(id);
    if (!owner) continue;
    const dir = relative(root, owner.dir).split(sep).join("/");
    if (dir.startsWith("..")) throw new Error(`RENDERER_PACKAGE_OUTSIDE_ROOT: ${owner.dir}`);
    found.set(`${owner.name}\n${dir}`, { name: owner.name, dir });
  }
  return [...found.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.dir.localeCompare(right.dir),
  );
}
