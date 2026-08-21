import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "apps/desktop/src/main.ts",
    preload: "apps/desktop/src/preload.ts",
  },
  format: ["cjs"],
  outDir: "apps/desktop/dist/main",
  outExtension: () => ({ js: ".cjs" }),
  clean: true,
  // 同 vite：main.cjs 344 KB，它的 map 623 KB。生产包不发 map。
  sourcemap: false,
  dts: false,
  external: ["electron", "better-sqlite3"],
  noExternal: [/^@ayanami-task\//u],
});
