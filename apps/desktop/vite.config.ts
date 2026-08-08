import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 9999,
    strictPort: true,
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
    sourcemap: true,
  },
});
