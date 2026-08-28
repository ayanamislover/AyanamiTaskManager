import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourcePath = join(process.cwd(), "apps", "desktop", "e2e", "desktop.spec.ts");

function legacyFixtureReads(source: string): string[] {
  return source.match(/projects\/E2E\/work-items\?limit=100/gu) ?? [];
}

describe("desktop E2E fixture contract", () => {
  it("固定任务始终从 canonical UI 分页端点读取", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(legacyFixtureReads(source)).toEqual([]);
    expect(source.match(/projects\/E2E\/ui\/work-items\?limit=100/gu)).toHaveLength(3);

    const mutated = source.replace(
      "projects/E2E/ui/work-items?limit=100",
      "projects/E2E/work-items?limit=100",
    );
    expect(legacyFixtureReads(mutated)).toHaveLength(1);
  });
});
