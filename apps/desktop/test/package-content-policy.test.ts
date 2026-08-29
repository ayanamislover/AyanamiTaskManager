import { describe, expect, it } from "vitest";
import {
  findForbiddenPackagedEntries,
  missingRequiredPackagedEntries,
  REQUIRED_PACKAGED_ENTRIES,
} from "../../../scripts/package-content-policy.js";

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
  });
});
