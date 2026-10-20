import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RENDERER_PACKAGES_FILE, rendererPackages } from "./scripts/renderer-packages.js";

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

// 3.0 的包里唯一的 JavaScript 是 renderer bundle：把实际打进去的 npm 包记下来，第三方声明照它收（W8a）。
// 写在 dist/renderer 之外，不进包。
function bundledPackages(): Plugin {
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  return {
    name: "atm-bundled-packages",
    apply: "build",
    generateBundle(_options, bundle) {
      const ids = Object.values(bundle).flatMap((item) =>
        item.type === "chunk" ? item.moduleIds : [],
      );
      const dist = fileURLToPath(new URL("dist", import.meta.url));
      mkdirSync(dist, { recursive: true });
      writeFileSync(
        `${dist}/${RENDERER_PACKAGES_FILE}`,
        `${JSON.stringify(rendererPackages(ids, repository), null, 2)}\n`,
        "utf8",
      );
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react(), devServerConnect(), bundledPackages()],
  server: {
    host: "127.0.0.1",
    port: 9999,
    strictPort: true,
    // 根是 apps/desktop：不监视原生构建目录（cargo 的 target 有几十 GB、上百万个文件）。
    // e2e 启动时刚在里面构建过适配器，监视器爬它会把首屏的模块转换拖住（W5d）。
    watch: { ignored: ["**/native/target/**", "**/native/target-*/**"] },
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
