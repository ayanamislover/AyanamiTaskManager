import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_SHIM_RELEASE_EXE } from "../../../scripts/mcp-shim-build.js";
import {
  assertMcpShimVersionResource,
  assertPublishedLogoBytes,
  findForbiddenPackagedEntries,
  missingRequiredPackagedEntries,
  REQUIRED_PACKAGED_ENTRIES,
} from "../../../scripts/package-content-policy.js";
import { ensureNativeShim } from "./native-shim.js";

const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
  .version;

/** VS_VERSIONINFO 的一条 String：键、NUL、padding 个零字节、值、NUL。 */
function versionString(value: string, padding: 0 | 2): Buffer {
  const nul = String.fromCharCode(0);
  return Buffer.concat([
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
  it("accepts the minimal runtime image", () => {
    const entries = [
      ...REQUIRED_PACKAGED_ENTRIES,
      "apps/desktop",
      "apps/desktop/dist/renderer/assets/index.js",
      "migrations/project/0018_session_list_keyset.sql",
      "node_modules/zod/package.json",
      "node_modules/better-sqlite3/build/Release",
      "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
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

  it("rejects repository sources, tests and native build metadata", () => {
    const forbidden = findForbiddenPackagedEntries([
      "/packages/domain/src/index.ts",
      "/scripts/release.ts",
      "/apps/desktop/test/runtime-request.test.ts",
      "/apps/desktop/src/main.ts",
      "/node_modules/.cache/prettier/.prettier-caches/abc.json",
      "/node_modules/better-sqlite3/build/better_sqlite3.vcxproj",
      "/node_modules/better-sqlite3/build/Release/obj/better_sqlite3.recipe",
    ]);

    expect(forbidden).toHaveLength(7);
  });

  it("reports missing runtime anchors", () => {
    expect(missingRequiredPackagedEntries(["package.json"])).toContain(
      "apps/desktop/dist/main/main.cjs",
    );
    expect(missingRequiredPackagedEntries(["package.json"])).toContain("logo.png");
    expect(missingRequiredPackagedEntries(["package.json"])).toContain(
      "migrations/knowledge/0001_initial.sql",
    );
  });

  it("rejects user knowledge while requiring its schema migration", () => {
    expect(
      findForbiddenPackagedEntries([
        "knowledge/private.md",
        "knowledge/knowledge.sqlite",
        "data/knowledge.sqlite-wal",
        "migrations/knowledge/0001_initial.sql",
      ]),
    ).toEqual(["data/knowledge.sqlite-wal", "knowledge/knowledge.sqlite", "knowledge/private.md"]);
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

  it("没有版本资源的 exe 被拒", () => {
    expect(() => assertMcpShimVersionResource(Buffer.alloc(4096), "1.2.3")).toThrow(
      /PACKAGED_MCP_SHIM_VERSION_RESOURCE_MISSING/u,
    );
  });

  it("forge 把 cargo 的 release 产物作为 extraResource 拷进 resources", () => {
    const forge = readFileSync("forge.config.ts", "utf8");
    const extraResource = /extraResource:\s*\[([\s\S]*?)\]/u.exec(forge)?.[1] ?? "";
    expect(extraResource).toContain(`"${MCP_SHIM_RELEASE_EXE}"`);
    // 打包入口先构建 shim 再打包、打完校验：顺序反了拷进去的就是上一次的构建。
    const api = readFileSync("scripts/forge-api.ts", "utf8");
    expect(api).toMatch(
      /packageApplication\(dir: string\): Promise<void> \{\s*buildMcpShim\(dir\);\s*await api\.package\(/u,
    );
    expect(api).toContain("assertMcpShimVersionResource(await readFile(shim), version)");
  });
});
