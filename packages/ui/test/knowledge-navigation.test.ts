import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/shell/sidebar.js";

describe("Knowledge navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn(() => null), setItem: vi.fn() },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("places the global knowledge page first in the collapsible workspace sidebar", () => {
    const markup = renderToStaticMarkup(
      createElement(Sidebar, {
        route: "knowledge",
        setRoute: vi.fn(),
        projects: [],
      }),
    );
    expect(markup).toContain("知识库");
    expect(markup).toContain('aria-current="page"');
  });

  it("keeps route, extraction, and draft state wiring explicit", () => {
    const root = process.cwd();
    const contracts = readFileSync(join(root, "packages", "ui", "src", "contracts.ts"), "utf8");
    const router = readFileSync(
      join(root, "packages", "ui", "src", "routes", "app-router.tsx"),
      "utf8",
    );
    const app = readFileSync(join(root, "packages", "ui", "src", "app.tsx"), "utf8");
    const records = readFileSync(
      join(root, "packages", "ui", "src", "features", "project-task-views.tsx"),
      "utf8",
    );
    expect(contracts).toContain('"knowledge"');
    expect(router).toContain('route === "knowledge"');
    expect(router).toContain("previewRecord");
    expect(app).toContain("knowledgeDraft");
    expect(records).toContain("提炼为共享知识草稿");
  });
});
