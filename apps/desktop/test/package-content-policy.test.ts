import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertExecutableIdentity,
  assertMcpShimVersionResource,
  executableInternalName,
  assertPublishedLogoBytes,
  buildMachinePathNeedles,
  findBuildMachinePath,
  findForbiddenPackagedEntries,
  missingRequiredPackagedEntries,
  REQUIRED_PACKAGED_ENTRIES,
} from "../../../scripts/package-content-policy.js";
import { releaseRustEnv } from "../../../scripts/rust-build-env.js";
import { ensureNativeShim } from "./native-shim.js";

const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
  .version;

/** VS_VERSIONINFO 的一条 String：键、NUL、padding 个零字节、值、NUL。 */
function versionString(value: string, padding: 0 | 2, decoy = ""): Buffer {
  const nul = String.fromCharCode(0);
  return Buffer.concat([
    // 大二进制的常量区里也可能有同名串（宿主链接的库就有），在版本资源之前。
    ...(decoy ? [Buffer.from(`ProductVersion${nul}${decoy}${nul}`, "utf16le")] : []),
    Buffer.from(`VS_VERSION_INFO${nul}`, "utf16le"),
    Buffer.from("AyanamiTaskManager MCP stdio bridge", "utf16le"),
    Buffer.from(`ProductVersion${nul}`, "utf16le"),
    Buffer.alloc(padding),
    Buffer.from(`${value}${nul}`, "utf16le"),
  ]);
}

function pngHeader(width: number, height: number, bytes = 24): Buffer {
  const header = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

describe("packaged application content policy", () => {
  it("accepts the minimal version directory", () => {
    const entries = [
      ...REQUIRED_PACKAGED_ENTRIES,
      "renderer/assets/index-BeYpKEDu.js",
      "renderer/assets/logo-DNGVc3qF.png",
      "migrations/project/0018_session_list_keyset.sql",
      "runtime/node_modules/better-sqlite3/LICENSE",
      "runtime/node_modules/better-sqlite3/lib/index.js",
      "resources/docs/user-guide.md",
      "resources/integrations/claude-code/README.md",
    ];

    expect(findForbiddenPackagedEntries(entries)).toEqual([]);
    expect(missingRequiredPackagedEntries(entries)).toEqual([]);
  });

  // 打包漏了最新的 Registry 迁移，装上后首启就会停在旧 schema；清单得跟着迁移目录走。
  it("requires the newest registry migration", () => {
    const newest = readdirSync("migrations/registry")
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .at(-1);
    expect(newest).toBeDefined();
    expect(REQUIRED_PACKAGED_ENTRIES).toContain(`migrations/registry/${newest}`);
  });

  it("rejects repository sources, source maps, native debug output and stray packages", () => {
    const forbidden = findForbiddenPackagedEntries([
      "/packages/domain/src/index.ts",
      "/scripts/release.ts",
      "apps/desktop/src/core-main.ts",
      "runtime/core.mjs.map",
      "AyanamiTaskManager.pdb",
      "launcher/atm_launcher.exp",
      "runtime/node_modules/zod/package.json",
      "runtime/node_modules/better-sqlite3/src/better_sqlite3.cpp",
      "runtime/node_modules/better-sqlite3/deps/sqlite3/sqlite3.c",
      "runtime/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      ".github/workflows/ci.yml",
    ]);

    expect(forbidden).toHaveLength(11);
  });

  it("reports missing runtime anchors", () => {
    const missing = missingRequiredPackagedEntries(["AyanamiTaskManager.exe"]);
    expect(missing).not.toContain("AyanamiTaskManager.exe");
    for (const anchor of [
      "LICENSE",
      "runtime/atm-core.exe",
      "runtime/node_modules/better-sqlite3/prebuilds/win32-x64.node",
      "resources/atm-mcp.exe",
      "migrations/knowledge/0001_initial.sql",
    ])
      expect(missing).toContain(anchor);
  });

  it("rejects user knowledge while requiring its schema migration", () => {
    expect(
      findForbiddenPackagedEntries([
        "knowledge/private.md",
        "knowledge/knowledge.sqlite",
        "data/registry.sqlite-wal",
        "migrations/knowledge/0001_initial.sql",
      ]),
    ).toEqual(["data/registry.sqlite-wal", "knowledge/knowledge.sqlite", "knowledge/private.md"]);
  });

  it("rejects a high-resolution or oversized published logo", () => {
    expect(() => assertPublishedLogoBytes(pngHeader(256, 256), "logo.png")).not.toThrow();
    expect(() => assertPublishedLogoBytes(pngHeader(684, 684), "logo.png")).toThrow(
      /PACKAGED_BRAND_ASSET_TOO_LARGE/u,
    );
    expect(() => assertPublishedLogoBytes(pngHeader(256, 256, 256 * 1024 + 1), "logo.png")).toThrow(
      /PACKAGED_BRAND_ASSET_TOO_LARGE/u,
    );
  });
});

describe("packaged MCP shim", () => {
  it("真实构建的 atm-mcp.exe 带版本资源，ProductVersion 就是 package.json 的版本", () => {
    const bytes = readFileSync(ensureNativeShim());
    expect(() => assertMcpShimVersionResource(bytes, packageVersion)).not.toThrow();
    // 阳性对照：换一个版本号必须报不一致，否则上一条什么都没验。
    expect(() => assertMcpShimVersionResource(bytes, "123.456.789")).toThrow(
      new RegExp(
        `PACKAGED_MCP_SHIM_VERSION_MISMATCH: expected 123\\.456\\.789, found ${packageVersion.replaceAll(".", "\\.")}`,
        "u",
      ),
    );
  });

  it("值前有无补齐字节都能读到；前缀相同的版本不算一致", () => {
    for (const padding of [0, 2] as const) {
      expect(() =>
        assertMcpShimVersionResource(versionString("1.2.3", padding), "1.2.3"),
      ).not.toThrow();
      expect(() => assertMcpShimVersionResource(versionString("1.2.30", padding), "1.2.3")).toThrow(
        /PACKAGED_MCP_SHIM_VERSION_MISMATCH/u,
      );
    }
  });

  it("常量区里在前面的同名串不影响：只读版本资源结构里的值", () => {
    expect(() =>
      assertMcpShimVersionResource(versionString("1.2.3", 0, "garbage"), "1.2.3"),
    ).not.toThrow();
    expect(() => assertMcpShimVersionResource(versionString("1.2.4", 0, "1.2.3"), "1.2.3")).toThrow(
      /PACKAGED_MCP_SHIM_VERSION_MISMATCH/u,
    );
  });

  it("宿主和根启动器同名同描述，只认 InternalName 区分", () => {
    const nul = String.fromCharCode(0);
    const exe = (internalName: string, padding: 0 | 2) =>
      Buffer.concat([
        // 常量区里在前面的同名键不算。
        Buffer.from(`InternalName${nul}AyanamiTaskManager.Launcher${nul}`, "utf16le"),
        Buffer.from(`VS_VERSION_INFO${nul}`, "utf16le"),
        Buffer.from(`InternalName${nul}`, "utf16le"),
        Buffer.alloc(padding),
        Buffer.from(`${internalName}${nul}`, "utf16le"),
      ]);
    for (const padding of [0, 2] as const) {
      expect(executableInternalName(exe("AyanamiTaskManager.Host", padding))).toBe(
        "AyanamiTaskManager.Host",
      );
      expect(() =>
        assertExecutableIdentity(
          exe("AyanamiTaskManager.Launcher", padding),
          "AyanamiTaskManager.Launcher",
          "LAUNCHER",
        ),
      ).not.toThrow();
      expect(() =>
        assertExecutableIdentity(
          exe("AyanamiTaskManager.Host", padding),
          "AyanamiTaskManager.Launcher",
          "LAUNCHER",
        ),
      ).toThrow(
        /PACKAGED_LAUNCHER_WRONG_EXECUTABLE: expected AyanamiTaskManager\.Launcher, found AyanamiTaskManager\.Host/u,
      );
    }
    expect(() => assertExecutableIdentity(Buffer.alloc(64), "atm-setup", "SETUP")).toThrow(
      /PACKAGED_SETUP_WRONG_EXECUTABLE: expected atm-setup, found null/u,
    );
  });

  it("没有版本资源的 exe 被拒", () => {
    expect(() => assertMcpShimVersionResource(Buffer.alloc(4096), "1.2.3")).toThrow(
      /PACKAGED_MCP_SHIM_VERSION_RESOURCE_MISSING/u,
    );
  });

  it("打包先构建 shim、从 cargo 的 release 产物拷进 resources，打完按版本资源校验", () => {
    const source = readFileSync("scripts/package-native.ts", "utf8");
    expect(source).toContain("mcpShimExe: join(root, MCP_SHIM_RELEASE_EXE),");
    // 顺序反了拷进去的就是上一次的构建。
    expect(source.indexOf("buildMcpShim(root);")).toBeGreaterThan(0);
    expect(source).toMatch(
      /assertMcpShimVersionResource\(readFileSync\(join\(appDir, "resources", "atm-mcp\.exe"\)\), version\)/u,
    );
  });

  // 每一次打包都过内容策略：缺件或夹带都在出包前失败，不靠事后抽查。
  it("打包在写清单前检查内容策略和发布 logo", () => {
    const source = readFileSync("scripts/package-native.ts", "utf8");
    const manifest = source.indexOf("const files: ManifestFile[] = [];");
    for (const check of [
      "findForbiddenPackagedEntries(payload)",
      "findBuildMachinePath(",
      "missingRequiredPackagedEntries(payload)",
      "assertPublishedLogoBytes(",
    ]) {
      expect(source, check).toContain(check);
      expect(source.indexOf(check), check).toBeLessThan(manifest);
    }
  });
});

// 依赖 crate 的源码路径会被编进 exe：1.2.2 发出去的 atm-mcp.exe 里就写着打包人的用户目录。
describe("构建机路径", () => {
  const needles = buildMachinePathNeedles(["C:\\Users\\builder", "D:\\src\\atm\\"]);

  it("原样、小写、正斜杠，UTF-8 与 UTF-16LE 都认得出", () => {
    for (const text of [
      "panicked at C:\\Users\\builder\\.cargo\\registry\\src\\x.rs",
      "c:\\users\\builder\\.cargo",
      "C:/Users/builder/.cargo",
      "d:/src/atm/host/src/app.rs",
    ]) {
      expect(findBuildMachinePath(Buffer.from(text, "utf8"), needles), text).not.toBeNull();
      expect(findBuildMachinePath(Buffer.from(text, "utf16le"), needles), text).not.toBeNull();
    }
    expect(findBuildMachinePath(Buffer.from("/cargo/registry/src/x.rs"), needles)).toBeNull();
  });

  it("发布构建把 cargo 主目录和仓库根重映射掉，并保留已有的 flag", () => {
    const separator = String.fromCharCode(0x1f);
    const env = releaseRustEnv("D:\\src\\atm", {
      CARGO_HOME: "C:\\Users\\builder\\.cargo",
      RUSTFLAGS: "-C target-cpu=native",
    });
    expect(env.CARGO_ENCODED_RUSTFLAGS?.split(separator)).toEqual([
      "-C",
      "target-cpu=native",
      "--remap-path-prefix=C:\\Users\\builder\\.cargo=/cargo",
      "--remap-path-prefix=D:\\src\\atm=/atm",
    ]);
  });

  it("所有发布用的 cargo 构建都走这份环境", () => {
    expect(readFileSync("scripts/mcp-shim-build.ts", "utf8")).toContain("...releaseRustEnv(root),");
    expect(readFileSync("scripts/package-native.ts", "utf8")).toContain("...releaseRustEnv(root),");
    expect(readFileSync("apps/desktop/test/native-shim.ts", "utf8")).toContain(
      "env: releaseRustEnv(process.cwd()),",
    );
  });
});
