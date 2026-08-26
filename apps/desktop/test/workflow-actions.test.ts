import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const workflowDirectory = resolve(root, ".github/workflows");

function readWorkflows(): Array<{ name: string; source: string }> {
  return readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/u.test(name))
    .map((name) => ({
      name,
      source: readFileSync(resolve(workflowDirectory, name), "utf8"),
    }));
}

describe("GitHub Actions runtime policy", () => {
  it("uses the current official Node 24 action majors", () => {
    const source = readWorkflows()
      .map(({ source }) => source)
      .join("\n");

    expect(source).toContain("uses: actions/checkout@v7");
    expect(source).toContain("uses: actions/setup-node@v7");
    expect(source).toContain("uses: pnpm/setup@v2");
    expect(source).not.toMatch(/uses:\s*pnpm\/action-setup@/u);
    expect(source).not.toMatch(/uses:\s*actions\/(?:checkout|setup-node)@v[1-4](?:\D|$)/u);
  });

  it("keeps pnpm cache and frozen-lockfile installation explicit", () => {
    const ci = readFileSync(resolve(workflowDirectory, "ci.yml"), "utf8");

    expect(ci).toMatch(/uses:\s*pnpm\/setup@v2[\s\S]*?with:\s*[\s\S]*?install:\s*false/u);
    expect(ci).toMatch(/uses:\s*actions\/setup-node@v7[\s\S]*?cache:\s*pnpm/u);
    expect(ci).toContain("run: pnpm install --frozen-lockfile");
  });
});
