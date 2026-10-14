import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// e2e 要的两个 Rust 程序：服务 atm-core-e2e，和设置页探测用的假 claude（W7e）。
// `pnpm test:e2e` 先单独跑这里，再起 Playwright：webServer 的 120 s 只等服务起来，不含编译。
// 冷缓存（CI 上的新机器）从零编译要好几分钟，算进 webServer 的超时就会超时（W8 关口在 CI 上）。
// start-e2e.ts 照样调它，缓存是热的时候只花一两秒，直接 `playwright test` 也还能用。
export function buildE2eBinaries(workspace: string): string {
  const native = join(workspace, "apps", "desktop", "native");
  const target = join(native, "target");
  const builds: Array<[string, string[]]> = [
    [
      "E2E_ADAPTER_BUILD_FAILED",
      ["build", "--locked", "-p", "atm-e2e-adapter", "--features", "e2e", "--bin", "atm-core-e2e"],
    ],
    // 设置页的「Claude Code」一行探测的是真实的程序：给它派单用例里的假 claude，不按 PATH 找本机真的那个。
    // 只探测版本与登录状态；e2e 不派单。
    [
      "E2E_FAKE_CLAUDE_BUILD_FAILED",
      ["build", "--locked", "-p", "atm-dispatch", "--bin", "atm-fake-claude"],
    ],
  ];
  for (const [code, args] of builds) {
    const build = spawnSync("cargo", args, {
      cwd: native,
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, CARGO_TARGET_DIR: target },
    });
    if (build.status !== 0) throw new Error(`${code}: ${build.status}`);
  }
  return target;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  buildE2eBinaries(process.cwd());
}
