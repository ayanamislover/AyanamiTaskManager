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
  sourcemap: true,
  dts: false,
  external: ["electron", "better-sqlite3"],
  noExternal: [/^@ayanami-task\//u],
});
