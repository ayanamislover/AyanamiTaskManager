import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertExecutableIdentity,
  assertMcpShimVersionResource,
  executableInternalName,
  assertPublishedLogoBytes,
  buildMachinePathNeedles,
  findBuildMachinePath,
  findForbiddenPackagedEntries,
  findTestBuildMarkers,
  missingRequiredPackagedEntries,
  REQUIRED_PACKAGED_ENTRIES,
  TEST_BUILD_MARKERS,
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
  it("accepts the minimal 3.0 version directory", () => {
    const entries = [
      ...REQUIRED_PACKAGED_ENTRIES,
      "renderer/assets/index-BeYpKEDu.js",
      "renderer/assets/logo-DNGVc3qF.png",
      "resources/docs/user-guide.md",
      "resources/integrations/claude-code/README.md",
    ];

    expect(findForbiddenPackagedEntries(entries)).toEqual([]);
    expect(missingRequiredPackagedEntries(entries)).toEqual([]);
  });

  // 3.0 是单进程（W8a）：与 setup 的 package.rs REQUIRED 是同一份 exe 清单，两边不能各说各的。
  it("requires the same executables as setup's package validation", () => {
    const setup = readFileSync("apps/desktop/native/setup/src/package.rs", "utf8");
    const required = /pub const REQUIRED: &\[&str\] = &\[([^\]]*)\]/u.exec(setup);
    expect(required).not.toBeNull();
    const setupEntries = [...required![1]!.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    expect(setupEntries.length).toBeGreaterThan(0);
    for (const entry of setupEntries) expect(REQUIRED_PACKAGED_ENTRIES).toContain(entry);
    expect(REQUIRED_PACKAGED_ENTRIES.filter((entry) => entry.endsWith(".exe")).sort()).toEqual(
      setupEntries.filter((entry) => entry!.endsWith(".exe")).sort(),
    );
  });

  it("rejects repository sources, source maps, native debug output and the 2.x Node runtime", () => {
    const forbidden = findForbiddenPackagedEntries([
      "/packages/domain/src/index.ts",
      "/scripts/release.ts",
      "apps/desktop/src/core-main.ts",
      "renderer/assets/index.js.map",
      "AyanamiTaskManager.pdb",
      "launcher/atm_launcher.exp",
      ".github/workflows/ci.yml",
      "atm-core-e2e.exe",
      "resources/atm-runtime.exe",
      // 2.x 的两进程布局：任何一件都不该再进 3.0 的包。
      "runtime/atm-core.exe",
      "runtime/core.mjs",
      "runtime/cli.mjs",
      "runtime/node_modules/better-sqlite3/package.json",
      "runtime/node_modules/better-sqlite3/prebuilds/win32-x64.node",
      "resources/mcp-stdio.cjs",
      "migrations/registry/0001_initial.sql",
      // 换个位置、换个名字也认得出。
      "resources/node.exe",
      "resources/atm-core.exe",
      "renderer/node_modules/react/index.js",
      "resources/bridge.mjs",
      "resources/addon.node",
    ]);

    expect(forbidden).toHaveLength(21);
    // 正式的二进制不受影响。
    expect(
      findForbiddenPackagedEntries([
        "AyanamiTaskManager.exe",
        "launcher/AyanamiTaskManager.exe",
        "resources/atm.exe",
        "resources/atm-mcp.exe",
        "atm-setup.exe",
      ]),
    ).toEqual([]);
  });

  it("reports missing runtime anchors", () => {
    const missing = missingRequiredPackagedEntries(["AyanamiTaskManager.exe"]);
    expect(missing).not.toContain("AyanamiTaskManager.exe");
    for (const anchor of [
      "LICENSE",
      "THIRD_PARTY_NOTICES.txt",
      "launcher/AyanamiTaskManager.exe",
      "atm-setup.exe",
      "resources/atm.exe",
      "resources/atm-mcp.exe",
      "renderer/index.html",
    ])
      expect(missing).toContain(anchor);
  });

  it("rejects user knowledge and databases", () => {
    expect(
      findForbiddenPackagedEntries([
        "knowledge/private.md",
        "knowledge/knowledge.sqlite",
        "data/registry.sqlite-wal",
        "resources/docs/local-knowledge.md",
      ]),
    ).toEqual(["data/registry.sqlite-wal", "knowledge/knowledge.sqlite", "knowledge/private.md"]);
  });

  // P-012：smoke、e2e、drill 构建的字面量出现在发出去的 exe 里，就是拿错了二进制。
  it("finds test-build markers in UTF-8 and UTF-16LE, except the builds a package allows", () => {
    for (const { build, marker } of TEST_BUILD_MARKERS) {
      for (const encoding of ["utf8", "utf16le"] as const) {
        const bytes = Buffer.concat([Buffer.alloc(16), Buffer.from(marker, encoding)]);
        expect(findTestBuildMarkers(bytes), `${marker} ${encoding}`).toEqual([
          `${build}:${marker}`,
        ]);
        expect(findTestBuildMarkers(bytes, [build]), `${marker} ${encoding}`).toEqual([]);
      }
    }
    // 名单钉住：少一条，那种拿错的二进制就漏过去了。
    expect(TEST_BUILD_MARKERS.map(({ build, marker }) => `${build}:${marker}`)).toEqual([
      "smoke:--remote-debugging-port",
      "smoke:ATM_SMOKE_WATCHDOG_MS",
      "smoke:ATM_SMOKE_CORE_USERPROFILE",
      "e2e:E2eTest",
      "e2e:atm-core-e2e: ",
      "e2e:ATM_E2E_",
      "drill:ATM_SETUP_SANDBOX",
      "drill:ATM_SETUP_DIE_AFTER",
      "drill:ATM_SETUP_FAIL_AT",
      "drill:ATM_SETUP_FAIL_UNDO",
      "drill:ATM_SETUP_SQUIRREL_ADDS",
    ]);
    // setup 的包校验里写着禁止的文件名 atm-core-e2e.exe：那不是 e2e 构建。
    expect(findTestBuildMarkers(Buffer.from('"resources/atm-core-e2e.exe"', "utf8"))).toEqual([]);
    expect(findTestBuildMarkers(Buffer.from("atm-core-e2e: listening", "utf8"))).toEqual([
      "e2e:atm-core-e2e: ",
    ]);
  });

  // 标记要对得上源码里真有的字面量，否则扫描永远是空的。它们只在测试特性或测试二进制里，
  // 由打出来的生产二进制本身来证明（打包时逐个 exe 扫，见下一条）。
  it("every marker is a literal the test builds really contain", () => {
    const read = (path: string) => readFileSync(`apps/desktop/native/${path}`, "utf8");
    const sources: Record<string, string> = {
      "--remote-debugging-port": read("host/src/app.rs"),
      ATM_SMOKE_WATCHDOG_MS: read("host/src/app.rs"),
      ATM_SMOKE_CORE_USERPROFILE: read("host/src/agents.rs") + read("host/src/child_env.rs"),
      E2eTest: read("domain/src/principal.rs"),
      "atm-core-e2e: ": read("e2e-adapter/src/main.rs"),
      ATM_E2E_: read("e2e-adapter/src/main.rs"),
      ATM_SETUP_SANDBOX: read("setup/src/env.rs"),
      ATM_SETUP_DIE_AFTER: read("setup/src/fault.rs"),
      ATM_SETUP_FAIL_AT: read("setup/src/fault.rs"),
      ATM_SETUP_FAIL_UNDO: read("setup/src/fault.rs"),
      ATM_SETUP_SQUIRREL_ADDS: read("setup/src/fault.rs") + read("setup/src/env.rs"),
    };
    for (const { marker } of TEST_BUILD_MARKERS) expect(sources[marker], marker).toContain(marker);
  });

  it("packaging scans every executable for test-build markers before the manifest", () => {
    const source = readFileSync("scripts/package-native.ts", "utf8");
    const manifest = source.indexOf("const files: ManifestFile[] = [];");
    const scan = source.indexOf("assertNoTestBuildMarkers(appDir, payload, {");
    expect(scan).toBeGreaterThan(0);
    expect(scan).toBeLessThan(manifest);
    // 生产包一个都不许；烟测包只放过宿主的 smoke，演练包只放过 setup 的 drill。
    expect(source).toContain('...(smoke ? { [APP_LAYOUT.host]: ["smoke"] } : {}),');
    expect(source).toContain('...(drill ? { [APP_LAYOUT.setup]: ["drill"] } : {}),');
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

  it("原样、小写、混合大小写、正斜杠，UTF-8 与 UTF-16LE 都认得出", () => {
    for (const text of [
      "panicked at C:\\Users\\builder\\.cargo\\registry\\src\\x.rs",
      "c:\\users\\builder\\.cargo",
      "C:\\USERS\\Builder\\.cargo",
      "C:/Users/builder/.cargo",
      "d:/src/atm/host/src/app.rs",
      "D:/Src/ATM/host/src/app.rs",
      // JSON 与 JS 字符串字面量里的反斜杠是两个，或写成 \u005c。
      '{"path":"C:\\\\Users\\\\builder\\\\.cargo"}',
      '{"path":"C:\\u005cUsers\\u005cBuilder\\u005c.cargo"}',
    ]) {
      expect(findBuildMachinePath(Buffer.from(text, "utf8"), needles), text).not.toBeNull();
      expect(findBuildMachinePath(Buffer.from(text, "utf16le"), needles), text).not.toBeNull();
    }
    expect(findBuildMachinePath(Buffer.from("/cargo/registry/src/x.rs"), needles)).toBeNull();
    // 非 ASCII 路径：汉字「字」的 UTF-16LE 是 57 5B，逐字节折 ASCII 会把 57 改坏；
    // 宽字符串从奇数偏移开始也要认得出。
    const wide = buildMachinePathNeedles(["C:\\Users\\字"]);
    expect(findBuildMachinePath(Buffer.from("x C:\\USERS\\字\\a", "utf16le"), wide)).not.toBeNull();
    expect(
      findBuildMachinePath(
        Buffer.concat([Buffer.from([0x20]), Buffer.from("C:\\USERS\\字", "utf16le")]),
        wide,
      ),
    ).not.toBeNull();
    expect(findBuildMachinePath(Buffer.from("C:\\Users\\字", "utf8"), wide)).not.toBeNull();
    expect(findBuildMachinePath(Buffer.from("C:\\Users\\宇", "utf16le"), wide)).toBeNull();
    // 非 ASCII 的大写字母：整体小写的写法也认。
    const accented = buildMachinePathNeedles(["C:\\Users\\ÉMILE"]);
    expect(findBuildMachinePath(Buffer.from("c:/users/émile/x", "utf8"), accented)).not.toBeNull();
    // 整条路径逐字符写成 \uXXXX（大小写不同的十六进制也一样）。
    const escaped = [..."C:\\Users\\builder"]
      .map(
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`,
      )
      .join("");
    expect(findBuildMachinePath(Buffer.from(`{"p":"${escaped}"}`, "utf8"), needles)).not.toBeNull();
    // 只折 ASCII：内容里的大写不能把别的字节也改了，原内容也不能被改动。
    const original = Buffer.from("C:\\USERS\\BUILDER", "utf8");
    findBuildMachinePath(original, needles);
    expect(original.toString("utf8")).toBe("C:\\USERS\\BUILDER");
  });

  it("发布构建不继承外面的 CARGO_TARGET_DIR；外面设过的也当构建机路径扫", () => {
    expect(
      releaseRustEnv("D:\\src\\atm", { CARGO_TARGET_DIR: "E:\\cargo-target" }).CARGO_TARGET_DIR,
    ).toBeUndefined();
    expect(readFileSync("scripts/package-native.ts", "utf8")).toContain(
      "...(process.env.CARGO_TARGET_DIR ? [resolve(root, process.env.CARGO_TARGET_DIR)] : []),",
    );
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
