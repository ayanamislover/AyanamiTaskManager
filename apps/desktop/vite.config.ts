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
    // 不清目录，每次构建的 index-<hash>.js 就会一直堆着，而 index.html 只引用
    // 最新那一份——19 份历次构建（连同 source map 共 35 MB）就是这么被打进
    // 装机包的。dist/main 由 tsup 写，和这里不是同一个目录，清空不会误伤。
    emptyOutDir: true,
    // source map 比代码本身大 4 倍（1.46 MB vs 0.39 MB），发给用户没有意义：
    // 本机有完整源码，要读生产堆栈把这里打开重构建一次就有。
    sourcemap: false,
  },
});
