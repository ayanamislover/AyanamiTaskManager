import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = join(process.cwd(), "apps", "desktop");
const rendererAssets = join(desktopRoot, "dist", "renderer", "assets");
const mainDist = join(desktopRoot, "dist", "main");

function assetsOrSkip(): string[] | null {
  if (!existsSync(rendererAssets)) return null;
  return readdirSync(rendererAssets);
}

describe("构建产物卫生", () => {
  // dist/renderer 原先不清目录，每次构建的 index-<hash>.js 都留下来，而 index.html
  // 只引用最新那一份。19 份历次构建连同 source map 共 35 MB，全被打进装机包，
  // 其中只有 0.39 MB 会被加载。
  it("渲染进程只留一份 bundle，且是 index.html 引用的那一份", () => {
    const files = assetsOrSkip();
    if (files === null) {
      // 没构建过就没有可断言的对象；不能让断言在空集上假绿。
      expect(existsSync(join(desktopRoot, "vite.config.ts"))).toBe(true);
      return;
    }
    const bundles = files.filter((name) => /^index-[\w-]+\.js$/u.test(name));
    expect(bundles).toHaveLength(1);
    const html = readFileSync(join(desktopRoot, "dist", "renderer", "index.html"), "utf8");
    expect(html).toContain(bundles[0]!);
  });

  it("打包产物里不带 source map", () => {
    const files = assetsOrSkip();
    if (files !== null) expect(files.filter((name) => name.endsWith(".map"))).toEqual([]);
    if (existsSync(mainDist)) {
      expect(readdirSync(mainDist).filter((name) => name.endsWith(".map"))).toEqual([]);
    }
  });

  // 上面两条依赖「构建过」才有意义，所以把配置本身也钉住：配置改回去，
  // 即使没有构建产物也要红。
  it("配置本身钉住：清目录开、生产 sourcemap 关", () => {
    const vite = readFileSync(join(desktopRoot, "vite.config.ts"), "utf8");
    expect(vite).toMatch(/emptyOutDir:\s*true/u);
    expect(vite).toMatch(/sourcemap:\s*false/u);
    const tsup = readFileSync(join(desktopRoot, "tsup.config.ts"), "utf8");
    expect(tsup).toMatch(/sourcemap:\s*false/u);
  });
});
