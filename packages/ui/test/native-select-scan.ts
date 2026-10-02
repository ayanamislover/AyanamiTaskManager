import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { productionFiles, repositoryRoot } from "./css-source-graph.js";

/**
 * 原生 <select> 的弹层由操作系统绘制，设计系统管不到；下拉一律自绘。
 * 桌面端与手机端的守卫共用这一套写法，免得一边补了漏洞、另一边还开着：
 *   - JSX 区分大小写：<Select 是自绘组件；HTML 不区分，<SELECT> 也是原生下拉；
 *   - 自闭合 <select/> 与 document.createElement("select") / React.createElement("select") 也算。
 */
export function nativeSelectOffenders(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([file, source]) => {
      const tag = file.endsWith(".html") ? /<select(?=[\s>/])/iu : /<select(?=[\s>/])/u;
      return tag.test(source) || /createElement\(\s*["'`]select["'`]/u.test(source);
    })
    .map(([file]) => file);
}

/** 各 app 的页面入口 index.html 不在 src 里，productionFiles 扫不到，单独列出。 */
export function appEntryHtmlFiles(): string[] {
  const apps = join(repositoryRoot, "apps");
  return readdirSync(apps, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(apps, entry.name, "index.html"))
    .filter((path) => existsSync(path));
}

/** 全部生产源码：apps/* 与 packages/* 的 src 下 TS/TSX/HTML，加上各 app 的 index.html。 */
export function nativeSelectScanFiles(): string[] {
  return [
    ...[".ts", ".tsx", ".html"].flatMap((extension) => productionFiles(extension)),
    ...appEntryHtmlFiles(),
  ];
}
