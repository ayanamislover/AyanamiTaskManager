import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "packages", "ui", "src");
const read = (...parts: string[]) => readFileSync(join(sourceRoot, ...parts), "utf8");

function missingPresenceContracts(sources: Record<string, string>): string[] {
  const contracts: Array<[string, string]> = [
    ["presence", 'data-presence": phase'],
    ["presence", "onTransitionEnd"],
    ["presence", "lastChildRef"],
    ["presence", "inertWhenClosing"],
    ["app", "<Presence present={Boolean(drawer)} inertWhenClosing>"],
    ["app-shell", "<Presence present={Boolean(noticeSlot)}>"],
    ["select", "<Presence present={open}"],
    ["select", "inertWhenClosing"],
    ["project", "<Presence present={create} inertWhenClosing>"],
    ["project", "<Presence present={createRecord} inertWhenClosing>"],
    ["project", "<Presence present={updateProject} inertWhenClosing>"],
    ["project", "<Presence present={dataTools} inertWhenClosing>"],
    ["projects", "<Presence present={wizard} inertWhenClosing>"],
    ["drawer", "{...presenceRootProps}"],
    ["create-task", "{...presenceRootProps}"],
    ["create-record", "{...presenceRootProps}"],
    ["project-update", "{...presenceRootProps}"],
    ["project-data", "{...presenceRootProps}"],
    ["projects", "{...presenceRootProps}"],
    ["overlays", '[data-presence="closing"]'],
    ["controls", '.atm-select-popover[data-presence="closing"]'],
    ["accessibility", "@media (prefers-reduced-motion: reduce)"],
    ["accessibility", '.atm-modal-backdrop[data-presence="closing"] .atm-modal:not(.atm-command)'],
    ["accessibility", '.atm-select-popover[data-presence="closing"]'],
    [
      "accessibility",
      '.atm-select[data-placement="top"] .atm-select-popover[data-presence="closing"]',
    ],
  ];
  return contracts
    .filter(([file, contract]) => !sources[file]?.includes(contract))
    .map(([file, contract]) => `${file}:${contract}`);
}

function productionSources(): Record<string, string> {
  return {
    presence: read("components", "presence.tsx"),
    app: read("app.tsx"),
    "app-shell": read("shell", "app-shell.tsx"),
    select: read("components", "atm-select.tsx"),
    project: read("features", "project.tsx"),
    projects: read("features", "projects.tsx"),
    drawer: read("features", "task-drawer.tsx"),
    "create-task": read("features", "create-task-modal.tsx"),
    "create-record": read("features", "create-record-modal.tsx"),
    "project-update": read("features", "project-update-modal.tsx"),
    "project-data": read("features", "project-data-modal.tsx"),
    overlays: read("styles", "overlays.css"),
    controls: read("styles", "controls.css"),
    accessibility: read("styles", "accessibility.css"),
  };
}

function closingRuleProperties(css: string): string[] {
  return [...css.matchAll(/[^{}]*\[data-presence="closing"\][^{}]*\{([^{}]*)\}/gu)].flatMap(
    (match) =>
      [...(match[1] ?? "").matchAll(/([a-z-]+)\s*:/gu)].map((declaration) => declaration[1]!),
  );
}

function rawTransitionDurations(css: string): string[] {
  return [...css.matchAll(/transition(?:-[a-z]+)?\s*:[^;{}]*\b\d+(?:ms|s)\b[^;{}]*;/gu)].map(
    (match) => match[0],
  );
}

describe("transient Presence integration", () => {
  it("批准 surface 共用有界 Presence，command palette 保持即时卸载", () => {
    const sources = productionSources();
    expect(missingPresenceContracts(sources)).toEqual([]);
    expect(sources.app).toMatch(/paletteSlot=\{\s*palette \? \(/u);
    expect(sources.app).not.toMatch(/<Presence present=\{palette\}>/u);
    expect(sources.overlays).toMatch(
      /\.atm-modal-backdrop:has\(\.atm-command\),\s*\.atm-command\s*\{\s*transition:\s*none;/u,
    );
  });

  it("退出态禁 pointer，Select 同时 inert；关键契约逐项 mutation 会验红", () => {
    const sources = productionSources();
    expect(sources.overlays).toMatch(
      /\[data-presence="closing"\][^{]*\{[^}]*pointer-events:\s*none/su,
    );
    expect(sources.presence).toContain('"aria-hidden": phase === "closing" ? true : undefined');

    for (const [file, contract] of [
      ["presence", "onTransitionEnd"],
      ["app", "<Presence present={Boolean(drawer)} inertWhenClosing>"],
      ["select", "inertWhenClosing"],
      ["project", "<Presence present={create} inertWhenClosing>"],
      ["projects", "<Presence present={wizard} inertWhenClosing>"],
      ["drawer", "{...presenceRootProps}"],
      ["controls", '.atm-select-popover[data-presence="closing"]'],
    ] as const) {
      expect(
        missingPresenceContracts({
          ...sources,
          [file]: sources[file]!.replaceAll(contract, "MUTATED"),
        }),
      ).toContain(`${file}:${contract}`);
    }
  });

  it("Presence motion 只使用 opacity/transform 和批准 token，reduced motion 压掉退出 transform", () => {
    const sources = productionSources();
    const motionCss = `${sources.overlays}\n${sources.controls}`;
    const closingProperties = closingRuleProperties(motionCss);
    expect(closingProperties.length).toBeGreaterThanOrEqual(7);
    expect([...new Set(closingProperties)].sort()).toEqual([
      "opacity",
      "pointer-events",
      "transform",
    ]);
    expect(rawTransitionDurations(motionCss)).toEqual([]);
    expect(sources.overlays).toContain("opacity var(--atm-duration-surface) var(--atm-ease-out)");
    expect(sources.controls).toContain("transform var(--atm-duration-hover) var(--atm-ease-out)");

    const rawDuration = motionCss.replace("opacity var(--atm-duration-surface)", "opacity 180ms");
    expect(rawTransitionDurations(rawDuration).length).toBeGreaterThan(0);
    const layoutMutation = motionCss.replace(
      "pointer-events: none;",
      "pointer-events: none;\n  width: 10px;",
    );
    expect(closingRuleProperties(layoutMutation)).toContain("width");
    expect(sources.accessibility).toMatch(
      /\.atm-modal-backdrop\[data-presence="closing"\][^{}]*\.atm-select\[data-placement="top"\] \.atm-select-popover\[data-presence="closing"\][^{]*\{\s*transform:\s*none;/su,
    );
  });
});
