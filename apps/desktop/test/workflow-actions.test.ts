import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const workflowDirectory = resolve(root, ".github/workflows");
const releaseWorkflowPath = resolve(workflowDirectory, "windows-release-validation.yml");
const releaseRunnerPath = resolve(root, "scripts/release.ts");
const distributionSmokePath = resolve(root, "scripts/distribution-smoke.ts");

type ReleaseValidationSources = {
  workflow: string;
  releaseRunner: string;
  distributionSmoke: string;
};

const releaseGateContracts = [
  {
    name: "full release orchestration",
    source: "workflow",
    needle: "run: pnpm release --full",
  },
  { name: "lint", source: "releaseRunner", needle: '{ name: "lint", args: ["lint"] },' },
  {
    name: "format",
    source: "releaseRunner",
    needle: '{ name: "format", args: ["format:check"] },',
  },
  {
    name: "typecheck",
    source: "releaseRunner",
    needle: '{ name: "typecheck", args: ["typecheck"] },',
  },
  { name: "unit tests", source: "releaseRunner", needle: '{ name: "test", args: ["test"] },' },
  { name: "desktop E2E", source: "releaseRunner", needle: '{ name: "e2e", args: ["test:e2e"] },' },
  {
    name: "benchmark",
    source: "releaseRunner",
    needle: '{ name: "benchmark", args: ["benchmark"] },',
  },
  { name: "build", source: "releaseRunner", needle: '{ name: "build", args: ["build"] },' },
  {
    name: "Forge make",
    source: "releaseRunner",
    needle: '{ name: "forge-make", args: ["exec", "tsx", "scripts/forge-make.ts"] },',
  },
  {
    name: "packaged smoke",
    source: "releaseRunner",
    needle: '{ name: "packaged-smoke", args: ["smoke:packaged"] },',
  },
  {
    name: "distribution smoke",
    source: "releaseRunner",
    needle:
      '{ name: "distribution-smoke", args: ["exec", "tsx", "scripts/distribution-smoke.ts"] },',
  },
  {
    name: "portable smoke",
    source: "distributionSmoke",
    needle: 'runPackagedSmoke("portable", portableExecutable);',
  },
  {
    name: "installed smoke",
    source: "distributionSmoke",
    needle: 'runPackagedSmoke("installed", installedExecutable);',
  },
] as const satisfies ReadonlyArray<{
  name: string;
  source: keyof ReleaseValidationSources;
  needle: string;
}>;

function missingReleaseGates(sources: ReleaseValidationSources): string[] {
  return releaseGateContracts
    .filter((contract) => !sources[contract.source].includes(contract.needle))
    .map((contract) => contract.name);
}

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

  it("keeps the full test gate bounded on Windows runners", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.test).toBe("vitest run --maxWorkers=1 --no-file-parallelism");
  });

  it("runs every release-only gate on a clean Windows runner", () => {
    const sources: ReleaseValidationSources = {
      workflow: readFileSync(releaseWorkflowPath, "utf8"),
      releaseRunner: readFileSync(releaseRunnerPath, "utf8"),
      distributionSmoke: readFileSync(distributionSmokePath, "utf8"),
    };

    expect(sources.workflow).toContain("runs-on: windows-latest");
    expect(sources.workflow).toContain("run: pnpm install --frozen-lockfile");
    expect(sources.workflow).not.toContain("pnpm release -- --full");
    expect(sources.workflow).toContain("output/release-verification.json");
    expect(sources.workflow).toContain("release/");
    expect(missingReleaseGates(sources)).toEqual([]);
  });

  it("detects each release gate independently when its contract is removed", () => {
    const sources: ReleaseValidationSources = {
      workflow: readFileSync(releaseWorkflowPath, "utf8"),
      releaseRunner: readFileSync(releaseRunnerPath, "utf8"),
      distributionSmoke: readFileSync(distributionSmokePath, "utf8"),
    };

    for (const contract of releaseGateContracts) {
      const mutated = {
        ...sources,
        [contract.source]: sources[contract.source].replace(contract.needle, ""),
      };
      expect(missingReleaseGates(mutated), contract.name).toContain(contract.name);
    }
  });
});
