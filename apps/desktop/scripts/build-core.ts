import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * core 与 CLI 打成两个单文件（de-electron §3）：依赖全部内联，只有 better-sqlite3 的原生模块
 * 留在外面，随包放在 runtime\node_modules\better-sqlite3（build\Release 或 prebuilds 下的 .node）。
 *
 * __ATM_PACKAGED__ 是 core 判断「打包态」的唯一依据：打包态强制父进程校验与布局校验，
 * 源码运行（tsx）时不存在这个常量。
 */
const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const outdir = resolve(root, "apps/desktop/dist/core");

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
