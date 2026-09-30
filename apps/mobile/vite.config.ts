import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  root,
  // 资源随 APK 打包，由 Capacitor 从 https://localhost/ 提供；相对路径两边都能用。
  base: "./",
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(manifest.version),
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    // 用到了 color-mix、@starting-style、:has 与 AbortSignal.any：Android System WebView 117+。
    target: "chrome117",
    // 整包约 610 KB（含 sync-protocol 与 zod），从 APK 本地读取，不走网络；拆包只会多几次本地请求。
    chunkSizeWarningLimit: 800,
  },
});
