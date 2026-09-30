import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { build, createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 渲染进程生产包只在宿主 WebView 里跑（ATM-T-0538）：不保留浏览器直连。
 * 真跑一次生产构建再断言产物，不看源码——源码里 DEV 分支还在是对的，
 * 要钉住的是「构建之后它没了」。
 */
const root = process.cwd();
const configFile = resolve(root, "apps/desktop/vite.config.ts");
let work = "";
let html = "";
let scripts = "";

function directives(policy: string): string[] {
  return policy
    .split(";")
    .map((part) => part.trim().replace(/\s+/gu, " "))
    .filter(Boolean)
    .sort();
}

beforeAll(async () => {
  mkdirSync(resolve(root, "output"), { recursive: true });
  work = mkdtempSync(join(resolve(root, "output"), "renderer-production-"));
  // vitest 把 NODE_ENV 设成 test，vite 会据此出开发版 bundle（DEV 为真）；
  // 这里要的是发布时那一份。
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({
      configFile,
      mode: "production",
      logLevel: "silent",
      build: { outDir: work, emptyOutDir: true },
    });
  } finally {
    process.env.NODE_ENV = previous;
  }
  html = readFileSync(join(work, "index.html"), "utf8");
  scripts = readdirSync(join(work, "assets"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(work, "assets", name), "utf8"))
    .join("\n");
}, 120_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe("渲染进程生产包", () => {
  it("不带浏览器直连：没有预览端口、预览 token，缺桥直接报错", () => {
    expect(scripts.length).toBeGreaterThan(10_000);
    expect(scripts).not.toContain("browser-preview-token");
    expect(scripts).not.toContain("127.0.0.1:43127");
    expect(scripts).not.toContain("VITE_ATM_");
    expect(scripts).toContain("ATM_DESKTOP_BRIDGE_MISSING");
  });

  it("meta CSP 与宿主下发的响应头逐条一致（meta 不支持的 frame-ancestors 除外）", () => {
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(html)?.[1];
    expect(meta).toBeTruthy();
    const assets = readFileSync(resolve(root, "apps/desktop/native/host/src/assets.rs"), "utf8");
    const header = /CONTENT_SECURITY_POLICY: &str = "([\s\S]*?)";/u
      .exec(assets)?.[1]
      ?.replace(/\\\r?\n/gu, "");
    expect(header).toBeTruthy();
    expect(directives(meta!)).toEqual(
      directives(header!).filter((directive) => !directive.startsWith("frame-ancestors")),
    );
    expect(meta).not.toContain("127.0.0.1");
  });

  it("只有 dev server 放开本机 daemon 与 HMR 的连接", async () => {
    const server = await createServer({
      configFile,
      logLevel: "silent",
      server: { middlewareMode: true, hmr: false },
    });
    try {
      const source = readFileSync(resolve(root, "apps/desktop/index.html"), "utf8");
      const served = await server.transformIndexHtml("/index.html", source);
      expect(served).toContain("connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*");
      expect(served).not.toContain("connect-src 'none'");
    } finally {
      await server.close();
    }
  }, 60_000);
});
