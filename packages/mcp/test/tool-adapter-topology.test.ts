import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { describe, expect, it } from "vitest";
import { createAyanamiToolRegistry } from "../src/index.js";

const sourceRoot = resolve("packages/mcp/src");

const manifest = [
  {
    path: "tools/core/begin.ts",
    profile: "core",
    name: "atm_begin",
    factory: "createAtmBeginTool",
  },
  {
    path: "tools/core/brief.ts",
    profile: "core",
    name: "atm_brief",
    factory: "createAtmBriefTool",
  },
  {
    path: "tools/core/task-list.ts",
    profile: "core",
    name: "atm_task_list",
    factory: "createAtmTaskListTool",
  },
  {
    path: "tools/core/task-get.ts",
    profile: "core",
    name: "atm_task_get",
    factory: "createAtmTaskGetTool",
  },
  {
    path: "tools/core/task-create.ts",
    profile: "core",
    name: "atm_task_create",
    factory: "createAtmTaskCreateTool",
  },
  {
    path: "tools/actions/task-patch.ts",
    profile: "actions",
    name: "atm_task_patch",
    factory: "createAtmTaskPatchTool",
  },
  {
    path: "tools/memory/progress-add.ts",
    profile: "memory",
    name: "atm_progress_add",
    factory: "createAtmProgressAddTool",
  },
  {
    path: "tools/memory/record.ts",
    profile: "memory",
    name: "atm_record",
    factory: "createAtmRecordTool",
  },
  {
    path: "tools/memory/search.ts",
    profile: "memory",
    name: "atm_search",
    factory: "createAtmSearchTool",
  },
  {
    path: "tools/memory/delta.ts",
    profile: "memory",
    name: "atm_delta",
    factory: "createAtmDeltaTool",
  },
  { path: "tools/core/end.ts", profile: "core", name: "atm_end", factory: "createAtmEndTool" },
] as const;

type TopologyInput = {
  files: ReadonlyMap<string, string>;
  profileSources: ReadonlyMap<string, string>;
  registeredNames: readonly string[];
};

const forbiddenAdapterPatterns = [
  { label: "storage package", pattern: /["']@ayanami-task\/storage-sqlite(?:[/"'])/u },
  { label: "SQLite driver", pattern: /["']better-sqlite3["']/u },
  {
    label: "direct SQL",
    pattern:
      /\b(?:SELECT\s+.+\s+FROM|INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|TRIGGER|INDEX)|DROP\s+(?:TABLE|TRIGGER|INDEX))\b/iu,
  },
  { label: "review binding preflight", pattern: /\.getReviewRequest\s*\(/u },
  { label: "reconciliation full scan", pattern: /\.reconcileProject\s*\(/u },
  { label: "transport expected-version map", pattern: /\bexpectedVersions\s*:/u },
] as const;

function assertToolAdapterTopology(input: TopologyInput): void {
  const expectedPaths = new Set(manifest.map((entry) => entry.path));
  for (const path of input.files.keys()) {
    if (!expectedPaths.has(path as (typeof manifest)[number]["path"])) {
      throw new Error(`UNDECLARED_TOOL_ADAPTER:${path}`);
    }
  }

  for (const entry of manifest) {
    const source = input.files.get(entry.path);
    if (source === undefined) throw new Error(`MISSING_TOOL_ADAPTER:${entry.path}`);
    if (!source.includes(`name: "${entry.name}"`)) {
      throw new Error(`TOOL_NAME_NOT_OWNED:${entry.path}:${entry.name}`);
    }
    if (!source.includes(`profile: "${entry.profile}"`)) {
      throw new Error(`TOOL_PROFILE_NOT_OWNED:${entry.path}:${entry.profile}`);
    }
    if (!/\bconst\s+inputSchema\s*=/u.test(source)) {
      throw new Error(`TOOL_SCHEMA_NOT_OWNED:${entry.path}`);
    }
    if (!/\binputSchema\.parse\(input\)/u.test(source)) {
      throw new Error(`TOOL_DECODE_NOT_OWNED:${entry.path}`);
    }
    if (!/\bhandler:\s*async\s*\(/u.test(source) || !/\bservice\./u.test(source)) {
      throw new Error(`TOOL_HANDLER_NOT_OWNED:${entry.path}`);
    }
    for (const forbidden of forbiddenAdapterPatterns) {
      if (forbidden.pattern.test(source)) {
        throw new Error(`TOOL_ADAPTER_BOUNDARY:${entry.path}:${forbidden.label}`);
      }
    }
    const profileSource = input.profileSources.get(entry.profile) ?? "";
    if (!profileSource.includes(`../${entry.path.replace(/\.ts$/u, ".js")}`)) {
      throw new Error(`PROFILE_IMPORT_MISSING:${entry.profile}:${entry.path}`);
    }
    if (!profileSource.includes(entry.factory)) {
      throw new Error(`PROFILE_FACTORY_MISSING:${entry.profile}:${entry.factory}`);
    }
  }

  const expectedNames = manifest.map((entry) => entry.name);
  if (JSON.stringify(input.registeredNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `TOOL_REGISTRY_MANIFEST_MISMATCH:${input.registeredNames.join(",")}:${expectedNames.join(",")}`,
    );
  }
}

function productionAdapterFiles(): Map<string, string> {
  const toolsRoot = resolve(sourceRoot, "tools");
  if (!existsSync(toolsRoot)) return new Map();
  const visit = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const absolute = resolve(directory, entry);
      return statSync(absolute).isDirectory() ? visit(absolute) : [absolute];
    });
  return new Map(
    visit(toolsRoot)
      .filter((path) => /[\\/](?:core|memory|actions)[\\/].+\.ts$/u.test(path))
      .map((absolute) => [
        relative(sourceRoot, absolute).replaceAll("\\", "/"),
        readFileSync(absolute, "utf8"),
      ]),
  );
}

function productionProfileSources(): Map<string, string> {
  return new Map(
    ["core", "memory", "actions"].map((profile) => {
      const path = resolve(sourceRoot, "profiles", `${profile}.ts`);
      return [profile, existsSync(path) ? readFileSync(path, "utf8") : ""];
    }),
  );
}

function validTopology(): TopologyInput {
  const files = new Map(
    manifest.map((entry) => [
      entry.path,
      [
        "const inputSchema = z.object({});",
        `export function ${entry.factory}(service) {`,
        `  return { name: "${entry.name}", profile: "${entry.profile}", inputSchema,`,
        "    handler: async (input) => { const decoded = inputSchema.parse(input); return wrap(await service.call(decoded)); },",
        "  };",
        "}",
      ].join("\n"),
    ]),
  );
  const profileSources = new Map(
    ["core", "memory", "actions"].map((profile) => [
      profile,
      manifest
        .filter((entry) => entry.profile === profile)
        .map(
          (entry) =>
            `import { ${entry.factory} } from "../${entry.path.replace(/\.ts$/u, ".js")}";\n${entry.factory};`,
        )
        .join("\n"),
    ]),
  );
  return { files, profileSources, registeredNames: manifest.map((entry) => entry.name) };
}

describe("one-tool-one-adapter topology", () => {
  it("binds every public tool contract and registration to exactly one adapter file", () => {
    const registeredNames = createAyanamiToolRegistry({} as AyanamiTaskService)
      .definitions()
      .map((definition) => definition.name);
    expect(() =>
      assertToolAdapterTopology({
        files: productionAdapterFiles(),
        profileSources: productionProfileSources(),
        registeredNames,
      }),
    ).not.toThrow();
  });

  it("proves missing files, detached registration and boundary leaks turn red", () => {
    const valid = validTopology();
    expect(() => assertToolAdapterTopology(valid)).not.toThrow();

    const missing = new Map(valid.files);
    missing.delete(manifest[0].path);
    expect(() => assertToolAdapterTopology({ ...valid, files: missing })).toThrow(
      `MISSING_TOOL_ADAPTER:${manifest[0].path}`,
    );

    expect(() =>
      assertToolAdapterTopology({ ...valid, registeredNames: valid.registeredNames.slice(1) }),
    ).toThrow("TOOL_REGISTRY_MANIFEST_MISMATCH");

    const detachedProfiles = new Map(valid.profileSources);
    detachedProfiles.set("core", "");
    expect(() => assertToolAdapterTopology({ ...valid, profileSources: detachedProfiles })).toThrow(
      "PROFILE_IMPORT_MISSING:core",
    );

    for (const forbidden of forbiddenAdapterPatterns) {
      const files = new Map(valid.files);
      files.set(
        manifest[0].path,
        `${files.get(manifest[0].path)}\n${
          forbidden.label === "storage package"
            ? 'import "@ayanami-task/storage-sqlite";'
            : forbidden.label === "SQLite driver"
              ? 'import "better-sqlite3";'
              : forbidden.label === "direct SQL"
                ? 'database.prepare("SELECT * FROM work_items");'
                : forbidden.label === "review binding preflight"
                  ? "service.getReviewRequest(project, request);"
                  : forbidden.label === "reconciliation full scan"
                    ? "service.reconcileProject(project);"
                    : "const context = { expectedVersions: versions };"
        }`,
      );
      expect(() => assertToolAdapterTopology({ ...valid, files })).toThrow(
        `TOOL_ADAPTER_BOUNDARY:${manifest[0].path}:${forbidden.label}`,
      );
    }
  });
});
