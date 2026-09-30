// 发布 APK 的内容断言：build-release.ps1 把 APK 里的 assets 解出来后调用。
//
//   node apps/mobile/scripts/assert-release.mjs <解出来的目录>
//
// 1. capacitor.config.json：不加载远程网页（没有 server.url）、不放行明文、关着 WebView 远程调试。
// 2. 网页资源：不含演示数据层（VITE_ATM_DEMO 只给开发构建）、不含 source map、不引用任何远程脚本。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("用法：node assert-release.mjs <目录>");
  process.exit(2);
}

const failures = [];
const config = JSON.parse(readFileSync(join(root, "assets", "capacitor.config.json"), "utf8"));
if (config.appId !== "moe.ayanami.atm")
  failures.push(`appId 应为 moe.ayanami.atm，实际 ${config.appId}`);
if (config.server?.url) failures.push(`发布包不应加载远程网页：server.url = ${config.server.url}`);
if (config.server?.cleartext) failures.push("发布包不应开启 server.cleartext");
if (config.android?.webContentsDebuggingEnabled) failures.push("发布包不应开启 WebView 远程调试");
if (config.android?.allowMixedContent) failures.push("发布包不应允许混合内容");
if (config.plugins?.CapacitorHttp?.enabled)
  failures.push("不应全局替换 fetch（CapacitorHttp.enabled）");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const publicDir = join(root, "assets", "public");
const files = walk(publicDir);
if (!files.some((file) => file.endsWith("index.html"))) failures.push("APK 里没有 index.html");
for (const file of files) {
  const name = relative(publicDir, file).replaceAll("\\", "/");
  if (name.endsWith(".map")) failures.push(`不应打包 source map：${name}`);
  if (!/\.(js|html|css)$/.test(name)) continue;
  const text = readFileSync(file, "utf8");
  if (text.includes("DemoBackend") || text.includes("演示离线"))
    failures.push(`发布包含有演示数据层：${name}`);
  if (/<script[^>]+src=["']https?:/i.test(text)) failures.push(`引用了远程脚本：${name}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log(`✓ APK 内容断言通过（${files.length} 个网页资源）`);
