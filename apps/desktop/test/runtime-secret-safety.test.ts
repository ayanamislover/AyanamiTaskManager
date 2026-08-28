import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("runtime secret safety guards", () => {
  it("keeps the legacy token filename confined to cleanup compatibility code", () => {
    const candidates = [
      "apps/daemon/src/runtime-discovery.ts",
      "apps/daemon/src/main.ts",
      "apps/desktop/src/runtime-host.ts",
      "apps/desktop/src/preload.ts",
      "apps/desktop/src/renderer.tsx",
      "packages/cli/src/index.ts",
      "packages/cli/src/runtime.ts",
      "scripts/migrate-data-root.ts",
    ];
    expect(candidates.length).toBeGreaterThan(5);
    const occurrences = candidates.filter((path) =>
      readFileSync(join(root, path), "utf8").includes("local.token"),
    );
    expect(occurrences).toEqual([
      "apps/daemon/src/runtime-discovery.ts",
      "scripts/migrate-data-root.ts",
    ]);

    const legacyWriter = (source: string) =>
      /(?:writeFileSync|copyFileSync|\.writeFile)\([^)]*local\.token/u.test(source);
    expect(legacyWriter('writeFileSync(join(runtime, "local.token"), token)')).toBe(true);
    for (const path of occurrences)
      expect(legacyWriter(readFileSync(join(root, path), "utf8")), path).toBe(false);
  });

  it("does not publish a CLI token argument or expose the descriptor through preload", () => {
    const cli = readFileSync(join(root, "packages/cli/src/index.ts"), "utf8");
    const preload = readFileSync(join(root, "apps/desktop/src/preload.ts"), "utf8");
    expect(cli).not.toContain("--token");
    expect(cli).not.toContain("--endpoint");
    expect(preload).not.toContain("atm:get-runtime");
    expect(preload).not.toContain("sendSync");
  });
});
