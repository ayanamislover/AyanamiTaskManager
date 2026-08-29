import { describe, expect, it } from "vitest";
import {
  assertPublishedLogoBytes,
  findForbiddenPackagedEntries,
  missingRequiredPackagedEntries,
  REQUIRED_PACKAGED_ENTRIES,
} from "../../../scripts/package-content-policy.js";

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
