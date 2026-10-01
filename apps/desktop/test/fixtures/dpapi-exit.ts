// 模拟 core 带着一个卡住的 DPAPI helper 直接 process.exit（例如握手被拒时退出 64）：
// helper 的超时由 core 看护，core 走了它必须跟着结束（dpapi.ts：helper 是非 detached 子进程）。
// 用法：node --import <tsx loader> dpapi-exit.ts <fake-dpapi.mjs> <pid 目录>（FAKE_DPAPI_MODE=hang）
import { readdirSync } from "node:fs";
import { hostDpapi } from "../../src/dpapi.js";

const [fakeHelper, pidDirectory] = process.argv.slice(2);
if (!fakeHelper || !pidDirectory)
  throw new Error("usage: dpapi-exit.ts <fake-dpapi.mjs> <pid dir>");
const dpapi = hostDpapi(process.execPath, { prefixArgs: [fakeHelper] });
void dpapi.protect(Buffer.from("x")).catch(() => undefined);
const timer = setInterval(() => {
  if (readdirSync(pidDirectory).length === 0) return;
  clearInterval(timer);
  process.exit(64);
}, 20);
