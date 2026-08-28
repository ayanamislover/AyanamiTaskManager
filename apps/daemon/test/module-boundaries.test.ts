import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "apps", "daemon", "src");
const modules = [
  "index.ts",
  "http-boundary.ts",
  "project-routes.ts",
  "rest-route-helpers.ts",
  "server-options.ts",
  "session-routes.ts",
  "transport-routes.ts",
  "work-routes.ts",
];

function source(name: string): string {
  return readFileSync(join(sourceRoot, name), "utf8");
}

describe("daemon host module boundaries", () => {
  it("keeps the composition root and every extracted host module within the 600-line budget", () => {
    expect(modules.length).toBeGreaterThan(1);
    for (const module of modules) {
      const lines = source(module).split(/\r?\n/u).length;
      expect(lines, `${module} has ${lines} lines`).toBeLessThanOrEqual(600);
    }
  });

  it("keeps routing and transport details out of the composition root", () => {
    const entry = source("index.ts");
    expect(entry).toContain("createHttpServer(options)");
    expect(entry).toContain("registerProjectRoutes(app, options, DAEMON_VERSION)");
    expect(entry).toContain("registerWorkRoutes(app, options)");
    expect(entry).toContain("registerSessionRoutes(app, options)");
    expect(entry).toContain("registerTransportRoutes(app, options)");
    expect(entry).not.toMatch(/app\.(?:get|post|put|patch|delete|route)\(/u);
  });

  it("keeps dependency direction toward shared options/helpers instead of back to index", () => {
    for (const module of modules.filter((name) => name !== "index.ts")) {
      expect({
        module,
        importsIndex: /from\s+["']\.\/index\.js["']/u.test(source(module)),
      }).toEqual({
        module,
        importsIndex: false,
      });
    }
    expect(source("http-boundary.ts")).toContain("app.setErrorHandler");
    expect(source("transport-routes.ts")).toContain('url: "/mcp/actions"');
    expect(source("transport-routes.ts")).toContain('app.get("/api/v1/ws"');
  });
});
