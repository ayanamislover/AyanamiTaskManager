import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeDesktopConfigPaths, installClaudeConfig } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const CONFIG = "claude_desktop_config.json";

/**
 * Store（MSIX）装的 Claude 带包身份，写 %APPDATA% 会被系统重定向进包容器，
 * 真正生效的是 %LOCALAPPDATA%\Packages\Claude_<publisherId>\LocalCache\Roaming\Claude\。
 * publisherId 是按发布者证书算出来的哈希，不能写死。
 */
function machine(options: { packaged?: string[]; classic?: boolean }): {
  env: NodeJS.ProcessEnv;
  classicPath: string;
  packagedPaths: string[];
} {
  const root = mkdtempSync(join(tmpdir(), "atm-claude-paths-"));
  temporary.push(root);
  const appData = join(root, "Roaming");
  const localAppData = join(root, "Local");
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  const packagedPaths: string[] = [];
  for (const publisher of options.packaged ?? []) {
    const container = join(localAppData, "Packages", `Claude_${publisher}`);
    mkdirSync(join(container, "LocalCache", "Roaming", "Claude"), { recursive: true });
    packagedPaths.push(join(container, "LocalCache", "Roaming", "Claude", CONFIG));
  }
  // 别的包不能被当成 Claude。
  mkdirSync(join(localAppData, "Packages", "SomethingElse_abc", "LocalCache"), {
    recursive: true,
  });
  if (options.classic) mkdirSync(join(appData, "Claude"), { recursive: true });

  return {
    env: { APPDATA: appData, LOCALAPPDATA: localAppData } as NodeJS.ProcessEnv,
    classicPath: join(appData, "Claude", CONFIG),
    packagedPaths,
  };
}

describe("Claude 桌面版配置位置", () => {
  // 这是 1.0.10~1.0.12 三轮「已修复」都没生效的原因：写进了 %APPDATA%\Claude 下那份
  // 旧安装留下的同名文件，读回来一切正常，而 Store 装的应用永远看不到它。
  it("Store 安装时必须给出包容器里那份，且排在经典路径之前", () => {
    const { env, classicPath, packagedPaths } = machine({ packaged: ["pzs8sxrjxfjjc"] });
    expect(claudeDesktopConfigPaths(env)).toEqual(packagedPaths);
    expect(claudeDesktopConfigPaths(env)[0]).not.toBe(classicPath);
  });

  it("两种形态都在时两份都要给出，包容器优先", () => {
    const { env, classicPath, packagedPaths } = machine({
      packaged: ["pzs8sxrjxfjjc"],
      classic: true,
    });
    expect(claudeDesktopConfigPaths(env)).toEqual([...packagedPaths, classicPath]);
  });

  // 目录不存在就说明那种形态没装。凭空建一个只会再造一个「写了没人读」的幽灵文件。
  it("只认父目录已经存在的候选", () => {
    const { env, classicPath } = machine({ classic: true });
    expect(claudeDesktopConfigPaths(env)).toEqual([classicPath]);
  });

  // 一个都没有时不能返回空数组，否则全新安装无处可写。
  it("一个都不存在时退回经典路径", () => {
    const { env, classicPath } = machine({});
    expect(claudeDesktopConfigPaths(env)).toEqual([classicPath]);
  });

  it("不给路径时写进全部候选，而不是只赌一个", () => {
    const { env, classicPath, packagedPaths } = machine({
      packaged: ["pzs8sxrjxfjjc"],
      classic: true,
    });
    const original = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
    process.env.APPDATA = env.APPDATA;
    process.env.LOCALAPPDATA = env.LOCALAPPDATA;
    try {
      installClaudeConfig({ command: "ATM_MARKER", args: ["bridge.cjs"] });
      for (const path of [...packagedPaths, classicPath]) {
        expect({ path, exists: existsSync(path) }).toEqual({ path, exists: true });
        expect(readFileSync(path, "utf8")).toContain("ATM_MARKER");
      }
    } finally {
      process.env.APPDATA = original.APPDATA;
      process.env.LOCALAPPDATA = original.LOCALAPPDATA;
    }
  });

  it("不把别的包当成 Claude", () => {
    const { env } = machine({ packaged: ["pzs8sxrjxfjjc"] });
    const foreign = join(
      env.LOCALAPPDATA!,
      "Packages",
      "SomethingElse_abc",
      "LocalCache",
      "Roaming",
      "Claude",
      CONFIG,
    );
    writeFileSync(join(env.LOCALAPPDATA!, "Packages", "SomethingElse_abc", "marker"), "x", "utf8");
    expect(claudeDesktopConfigPaths(env)).not.toContain(foreign);
  });
});
