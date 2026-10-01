import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// index.html 写的是生产 CSP（与宿主 assets.rs 下发的响应头一致，connect-src 'none'）。
// 只有 dev server 需要让页面直连本机 daemon 和 HMR 的 websocket。
const DEV_CONNECT_SRC = "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*";
function devServerConnect(): Plugin {
  return {
    name: "atm-dev-server-connect",
    apply: "serve",
    transformIndexHtml(html) {
      if (!html.includes("connect-src 'none'")) throw new Error("ATM_DEV_CSP_ANCHOR_MISSING");
      return html.replace("connect-src 'none'", DEV_CONNECT_SRC);
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react(), devServerConnect()],
  server: {
    host: "127.0.0.1",
    port: 9999,
    strictPort: true,
  },
  build: {
    outDir: "dist/renderer",
    // 不清目录，每次构建的 index-<hash>.js 就会一直堆着，而 index.html 只引用
    // 最新那一份——19 份历次构建（连同 source map 共 35 MB）就是这么被打进
    // 装机包的。dist/core 由 build-core 写，和这里不是同一个目录，清空不会误伤。
    emptyOutDir: true,
    // source map 比代码本身大 4 倍（1.46 MB vs 0.39 MB），发给用户没有意义：
    // 本机有完整源码，要读生产堆栈把这里打开重构建一次就有。
    sourcemap: false,
  },
});
