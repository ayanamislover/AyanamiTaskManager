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

  it("所有桌面桥 mock 都提供渲染器就绪信号", () => {
    const source = readFileSync(sourcePath, "utf8");
    const readySignals = source.match(/notifyRendererReady:\s*\(\)\s*=>\s*undefined/gu) ?? [];

    expect(source.match(/ayanamiDesktop\s*=/gu)).toHaveLength(1);
    expect(source.match(/Object\.defineProperty\(window,\s*"ayanamiDesktop"/gu)).toHaveLength(1);
    expect(readySignals).toHaveLength(2);

    const mutated = source.replace("notifyRendererReady: () => undefined,", "");
    expect(mutated.match(/notifyRendererReady:\s*\(\)\s*=>\s*undefined/gu)).toHaveLength(1);
  });
});
