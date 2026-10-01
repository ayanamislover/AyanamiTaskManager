import { build, type Plugin } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * core 与 CLI 打成两个单文件（de-electron §3）：依赖全部内联，只有 better-sqlite3 的原生模块
 * 留在外面，随包放在 runtime\node_modules\better-sqlite3（build\Release 或 prebuilds 下的 .node）。
 *
 * __ATM_PACKAGED__ 是 core 判断「打包态」的唯一依据：打包态强制父进程校验与布局校验，
 * 源码运行（tsx）时不存在这个常量。
 */
const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
/**
 * 安装演练要第二个版本号的包（更新、回滚都要两个版本）。ATM_DRILL_VERSION 只换 core 自报的
 * DAEMON_VERSION，且只允许构建到 output/ 下，发布产物目录永远是源码里的版本。
 */
const drillVersion = process.env.ATM_DRILL_VERSION;
const outdir = resolve(process.env.ATM_CORE_OUT_DIR ?? resolve(root, "apps/desktop/dist/core"));
if (drillVersion !== undefined) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u.test(drillVersion))
    throw new Error(`ATM_DRILL_VERSION_INVALID: ${drillVersion}`);
  if (!outdir.toLowerCase().startsWith(`${resolve(root, "output").toLowerCase()}${sep}`))
    throw new Error(`ATM_DRILL_VERSION_OUTSIDE_OUTPUT: ${outdir}`);
}
const versionPlugin: Plugin = {
  name: "atm-drill-version",
  setup(context) {
    // esbuild compiles the filter as a Go regular expression, which has no `u` flag.
    context.onLoad({ filter: /runtime-discovery\.ts$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      const replaced = source.replace(
        /export const DAEMON_VERSION = "[^"]+";/u,
        `export const DAEMON_VERSION = ${JSON.stringify(drillVersion)};`,
      );
      if (replaced === source) throw new Error("ATM_DRILL_VERSION_ANCHOR_MISSING");
      return { contents: replaced, loader: "ts" };
    });
  },
};

const shared = {
  bundle: true,
  platform: "node" as const,
  format: "esm" as const,
  target: "node24",
  minify: true,
  legalComments: "none" as const,
  sourcemap: false,
  external: ["better-sqlite3"],
  // 内联的 CJS 依赖会调用 require；ESM 输出里给它一个。
  banner: {
    js: "import { createRequire as __atmCreateRequire } from 'node:module'; const require = __atmCreateRequire(import.meta.url);",
  },
  define: { __ATM_PACKAGED__: "true" },
  logLevel: "warning" as const,
  plugins: drillVersion === undefined ? [] : [versionPlugin],
};

await build({
  ...shared,
  entryPoints: { core: resolve(root, "apps/desktop/src/core-main.ts") },
  outdir,
  outExtension: { ".js": ".mjs" },
});
await build({
  ...shared,
  entryPoints: { cli: resolve(root, "apps/desktop/src/cli-main.ts") },
  outdir,
  outExtension: { ".js": ".mjs" },
});
