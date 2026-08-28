import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import ts from "typescript";

export type ProductionSourceFile = {
  path: string;
  packageName: string;
  source: string;
};

export type WorkspacePackage = {
  name: string;
  root: string;
  declaredDependencies: string[];
  publicSpecifiers?: string[];
};

export type SourceInventory = {
  files: ProductionSourceFile[];
  packages: WorkspacePackage[];
};

export type ArchitectureException = {
  path: string;
  limit: number;
  owner: string;
  reason: string;
};

export type ArchitectureViolation = {
  code: string;
  path: string;
  detail: string;
};

export type ArchitectureReport = {
  fileCount: number;
  importCount: number;
  packageCount: number;
  violations: ArchitectureViolation[];
};

export const DEFAULT_WORKSPACE_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  "@ayanami-task/agent-config": [],
  "@ayanami-task/application": [
    "@ayanami-task/domain",
    "@ayanami-task/engineering-metrics",
    "@ayanami-task/errors",
    "@ayanami-task/protocol",
    "@ayanami-task/storage-sqlite",
  ],
  "@ayanami-task/client": ["@ayanami-task/errors", "@ayanami-task/protocol"],
  "@ayanami-task/cli": ["@ayanami-task/client", "@ayanami-task/protocol"],
  "@ayanami-task/daemon": [
    "@ayanami-task/application",
    "@ayanami-task/errors",
    "@ayanami-task/mcp",
    "@ayanami-task/protocol",
  ],
  "@ayanami-task/desktop": [
    "@ayanami-task/agent-config",
    "@ayanami-task/application",
    "@ayanami-task/client",
    "@ayanami-task/cli",
    "@ayanami-task/daemon",
    "@ayanami-task/mcp",
    "@ayanami-task/ui",
  ],
  "@ayanami-task/domain": ["@ayanami-task/errors"],
  "@ayanami-task/engineering-metrics": [],
  "@ayanami-task/errors": [],
  "@ayanami-task/mcp": [
    "@ayanami-task/application",
    "@ayanami-task/errors",
    "@ayanami-task/protocol",
  ],
  "@ayanami-task/protocol": ["@ayanami-task/errors"],
  "@ayanami-task/storage-sqlite": [
    "@ayanami-task/domain",
    "@ayanami-task/errors",
    "@ayanami-task/protocol",
  ],
  "@ayanami-task/testing": [],
  "@ayanami-task/ui": ["@ayanami-task/client", "@ayanami-task/protocol"],
};

const sourceExtensions = [".ts", ".tsx"] as const;
const workspacePrefix = "@ayanami-task/";

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function visitSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return visitSourceFiles(path);
    if (!entry.isFile() || !sourceExtensions.some((extension) => entry.name.endsWith(extension))) {
      return [];
    }
    return entry.name.endsWith(".d.ts") ? [] : [path];
  });
}

export function collectRepositorySources(repositoryRoot: string): SourceInventory {
  const packages: WorkspacePackage[] = [];
  const files: ProductionSourceFile[] = [];
  for (const group of ["apps", "packages"]) {
    const groupRoot = join(repositoryRoot, group);
    for (const entry of readdirSync(groupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = join(groupRoot, entry.name);
      const manifestPath = join(root, "package.json");
      const sourceRoot = join(root, "src");
      if (!existsSync(manifestPath) || !existsSync(sourceRoot)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (typeof manifest.name !== "string") throw new Error(`PACKAGE_NAME_MISSING:${root}`);
      const declared = ["dependencies", "optionalDependencies", "peerDependencies"].flatMap(
        (field) => Object.keys((manifest[field] as Record<string, unknown> | undefined) ?? {}),
      );
      packages.push({
        name: manifest.name,
        root: normalizedPath(relative(repositoryRoot, root)),
        declaredDependencies: [...new Set(declared)].sort(),
        publicSpecifiers: [
          manifest.name,
          ...Object.keys(
            manifest.exports &&
              typeof manifest.exports === "object" &&
              !Array.isArray(manifest.exports)
              ? (manifest.exports as Record<string, unknown>)
              : {},
          )
            .filter((key) => key.startsWith("./"))
            .map((key) => `${manifest.name}/${key.slice(2)}`),
        ].sort(),
      });
      for (const path of visitSourceFiles(sourceRoot)) {
        files.push({
          path: normalizedPath(relative(repositoryRoot, path)),
          packageName: manifest.name,
          source: readFileSync(path, "utf8"),
        });
      }
    }
  }
  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    packages: packages.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

type ImportReference = { specifier: string; runtime: boolean };

function importClauseHasRuntime(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)))
    return true;
  if (!clause.namedBindings || clause.namedBindings.elements.length === 0) return true;
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function exportDeclarationHasRuntime(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return true;
  if (node.exportClause.elements.length === 0) return true;
  return node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function sourceImports(file: ProductionSourceFile): ImportReference[] {
  const scriptKind = file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    file.path,
    file.source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const imports: ImportReference[] = [];
  const add = (node: ts.Expression | undefined, runtime: boolean) => {
    if (node && ts.isStringLiteralLike(node)) imports.push({ specifier: node.text, runtime });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, importClauseHasRuntime(node.importClause));
    } else if (ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, exportDeclarationHasRuntime(node));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, !node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isLiteralRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isLiteralRequire) add(node.arguments[0], true);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function workspacePackageName(specifier: string): string | null {
  if (!specifier.startsWith(workspacePrefix)) return null;
  const [scope, name] = specifier.split("/");
  return scope && name ? `${scope}/${name}` : null;
}

function relativeImportTarget(
  importer: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const imported = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const withoutJs = imported.endsWith(".js") ? imported.slice(0, -3) : imported;
  const candidates = [
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    posix.join(withoutJs, "index.ts"),
    posix.join(withoutJs, "index.tsx"),
  ];
  return candidates.find((candidate) => knownPaths.has(candidate)) ?? null;
}

function firstCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (path: string): string[] | null => {
    if (visiting.has(path)) return [...stack.slice(stack.indexOf(path)), path];
    if (visited.has(path)) return null;
    visiting.add(path);
    stack.push(path);
    for (const target of graph.get(path) ?? []) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(path);
    visited.add(path);
    return null;
  };
  for (const path of [...graph.keys()].sort()) {
    const cycle = visit(path);
    if (cycle) return cycle;
  }
  return null;
}

function uiSeamViolation(
  file: ProductionSourceFile,
  specifier: string,
  target: string | null,
  runtime: boolean,
): string | null {
  const inShell = file.path.startsWith("packages/ui/src/shell/");
  const inPrimitive = file.path.startsWith("packages/ui/src/components/");
  const inHook = file.path.startsWith("packages/ui/src/hooks/");
  const isPresentation = file.path === "packages/ui/src/presentation.tsx";
  const isContracts = file.path === "packages/ui/src/contracts.ts";
  if (!inShell && !inPrimitive && !inHook && !isPresentation && !isContracts) return null;
  if (specifier === "@ayanami-task/client" || specifier === "@tanstack/react-query") {
    if (isContracts && specifier === "@ayanami-task/client" && !runtime) return null;
    return `${file.path} imports ${specifier}`;
  }
  if (!target) return null;
  const sharedLowLevelTargets = [
    "packages/ui/src/components/",
    "packages/ui/src/hooks/",
    "packages/ui/src/contracts.ts",
    "packages/ui/src/presentation.tsx",
  ];
  const allowedTargets = inShell
    ? ["packages/ui/src/shell/", ...sharedLowLevelTargets]
    : inPrimitive
      ? sharedLowLevelTargets
      : inHook
        ? [...sharedLowLevelTargets, "packages/ui/src/notice-lifecycle.ts"]
        : isPresentation
          ? ["packages/ui/src/contracts.ts"]
          : [];
  return allowedTargets.some((prefix) => target.startsWith(prefix))
    ? null
    : `${file.path} imports higher UI module ${target}`;
}

export function auditImportArchitecture(
  inventory: SourceInventory,
  allowedDependencies: Readonly<Record<string, readonly string[]>> = DEFAULT_WORKSPACE_DEPENDENCIES,
): ArchitectureReport {
  const violations: ArchitectureViolation[] = [];
  const filesByPath = new Map(inventory.files.map((file) => [file.path, file]));
  const knownPaths = new Set(filesByPath.keys());
  const packageByName = new Map(inventory.packages.map((entry) => [entry.name, entry]));
  const entryByPackage = new Map(
    inventory.packages.map((entry) => [entry.name, `${entry.root}/src/index.ts`]),
  );
  const runtimeGraph = new Map<string, string[]>(inventory.files.map((file) => [file.path, []]));
  const completeGraph = new Map<string, string[]>(inventory.files.map((file) => [file.path, []]));
  const packageGraph = new Map<string, string[]>(
    inventory.packages.map((entry) => [entry.name, []]),
  );
  const usedWorkspaceDependencies = new Map<string, Set<string>>(
    inventory.packages.map((entry) => [entry.name, new Set<string>()]),
  );
  let importCount = 0;

  for (const [name, targets] of Object.entries(allowedDependencies)) {
    if (!packageByName.has(name)) {
      violations.push({ code: "UNUSED_PACKAGE_POLICY", path: name, detail: "package is absent" });
    }
    for (const target of targets) {
      if (!packageByName.has(target)) {
        violations.push({ code: "PACKAGE_POLICY_TARGET_MISSING", path: name, detail: target });
      }
    }
  }
  for (const entry of inventory.packages) {
    if (!(entry.name in allowedDependencies)) {
      violations.push({ code: "PACKAGE_POLICY_MISSING", path: entry.root, detail: entry.name });
    }
  }

  for (const file of inventory.files) {
    for (const reference of sourceImports(file)) {
      importCount += 1;
      const relativeTarget = relativeImportTarget(file.path, reference.specifier, knownPaths);
      const targetPackage = workspacePackageName(reference.specifier);
      const seam = uiSeamViolation(file, reference.specifier, relativeTarget, reference.runtime);
      if (seam) violations.push({ code: "UI_SEAM_VIOLATION", path: file.path, detail: seam });
      if (relativeTarget) {
        completeGraph.get(file.path)!.push(relativeTarget);
        if (reference.runtime) runtimeGraph.get(file.path)!.push(relativeTarget);
        const relativeTargetFile = filesByPath.get(relativeTarget);
        if (relativeTargetFile && relativeTargetFile.packageName !== file.packageName) {
          violations.push({
            code: "CROSS_PACKAGE_RELATIVE_IMPORT",
            path: file.path,
            detail: `${file.packageName}->${relativeTargetFile.packageName}:${relativeTarget}`,
          });
          packageGraph.get(file.packageName)?.push(relativeTargetFile.packageName);
        }
      }
      if (!targetPackage) continue;
      usedWorkspaceDependencies.get(file.packageName)?.add(targetPackage);
      if (!packageByName.has(targetPackage)) {
        violations.push({
          code: "WORKSPACE_PACKAGE_NOT_FOUND",
          path: file.path,
          detail: targetPackage,
        });
      }
      const publicSpecifiers = new Set([
        targetPackage,
        ...(packageByName.get(targetPackage)?.publicSpecifiers ?? []),
      ]);
      if (!publicSpecifiers.has(reference.specifier)) {
        violations.push({
          code: "PACKAGE_PRIVATE_IMPORT",
          path: file.path,
          detail: reference.specifier,
        });
        continue;
      }
      if (targetPackage === file.packageName) {
        violations.push({ code: "PACKAGE_SELF_IMPORT", path: file.path, detail: targetPackage });
        continue;
      }
      const allowed = allowedDependencies[file.packageName] ?? [];
      if (!allowed.includes(targetPackage)) {
        violations.push({
          code: "FORBIDDEN_PACKAGE_IMPORT",
          path: file.path,
          detail: `${file.packageName}->${targetPackage}`,
        });
      }
      if (!packageByName.get(file.packageName)?.declaredDependencies.includes(targetPackage)) {
        violations.push({
          code: "UNDECLARED_WORKSPACE_DEPENDENCY",
          path: file.path,
          detail: `${file.packageName}->${targetPackage}`,
        });
      }
      packageGraph.get(file.packageName)?.push(targetPackage);
      const entry = entryByPackage.get(targetPackage);
      if (reference.specifier === targetPackage && entry && knownPaths.has(entry)) {
        completeGraph.get(file.path)!.push(entry);
        if (reference.runtime) runtimeGraph.get(file.path)!.push(entry);
      }
    }
  }

  for (const entry of inventory.packages) {
    const allowed = allowedDependencies[entry.name] ?? [];
    const used = usedWorkspaceDependencies.get(entry.name) ?? new Set<string>();
    for (const dependency of allowed) {
      if (!used.has(dependency)) {
        violations.push({
          code: "UNUSED_ALLOWED_DEPENDENCY",
          path: entry.root,
          detail: `${entry.name}->${dependency}`,
        });
      }
    }
    for (const dependency of entry.declaredDependencies.filter((name) =>
      name.startsWith(workspacePrefix),
    )) {
      if (!allowed.includes(dependency)) {
        violations.push({
          code: "DECLARED_DEPENDENCY_OUTSIDE_POLICY",
          path: entry.root,
          detail: `${entry.name}->${dependency}`,
        });
      }
      if (!used.has(dependency)) {
        violations.push({
          code: "UNUSED_RUNTIME_WORKSPACE_DEPENDENCY",
          path: entry.root,
          detail: `${entry.name}->${dependency}`,
        });
      }
    }
  }

  const runtimeCycle = firstCycle(runtimeGraph);
  if (runtimeCycle) {
    violations.push({
      code: "RUNTIME_IMPORT_CYCLE",
      path: runtimeCycle[0]!,
      detail: runtimeCycle.join(" -> "),
    });
  }
  const completeCycle = firstCycle(completeGraph);
  if (completeCycle && !runtimeCycle) {
    violations.push({
      code: "TYPE_IMPORT_CYCLE",
      path: completeCycle[0]!,
      detail: completeCycle.join(" -> "),
    });
  }
  const packageCycle = firstCycle(packageGraph);
  if (packageCycle) {
    violations.push({
      code: "WORKSPACE_IMPORT_CYCLE",
      path: packageCycle[0]!,
      detail: packageCycle.join(" -> "),
    });
  }
  return {
    fileCount: inventory.files.length,
    importCount,
    packageCount: inventory.packages.length,
    violations,
  };
}

function sourceLineCount(source: string): number {
  if (source.length === 0) return 0;
  const withoutTerminalNewline = source.replace(/\r?\n$/u, "");
  return withoutTerminalNewline.split(/\r?\n/u).length;
}

function isSqlHeavy(file: ProductionSourceFile): boolean {
  return (
    file.path.startsWith("packages/storage-sqlite/src/") &&
    /\b(?:prepare|transaction)\s*\(|better-sqlite3/u.test(file.source)
  );
}

export function auditSourceSizes(
  files: readonly ProductionSourceFile[],
  rawExceptions: unknown,
): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  if (!Array.isArray(rawExceptions)) {
    return [
      {
        code: "INVALID_EXCEPTION_CATALOG",
        path: "architecture-exceptions.json",
        detail: "expected array",
      },
    ];
  }
  const exceptions = new Map<string, ArchitectureException>();
  for (const [index, value] of rawExceptions.entries()) {
    const path = `architecture-exceptions.json[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      violations.push({ code: "INVALID_SIZE_EXCEPTION", path, detail: "expected object" });
      continue;
    }
    const candidate = value as Record<string, unknown>;
    const keys = Object.keys(candidate).sort();
    if (keys.join(",") !== "limit,owner,path,reason") {
      violations.push({ code: "INVALID_SIZE_EXCEPTION", path, detail: `keys:${keys.join(",")}` });
      continue;
    }
    if (
      typeof candidate.path !== "string" ||
      candidate.path.includes("\\") ||
      candidate.path.includes("..") ||
      !/^(?:apps|packages)\/[^/]+\/src\/.+\.tsx?$/u.test(candidate.path)
    ) {
      violations.push({ code: "INVALID_SIZE_EXCEPTION", path, detail: "non-canonical path" });
      continue;
    }
    if (
      !Number.isInteger(candidate.limit) ||
      Number(candidate.limit) <= 600 ||
      Number(candidate.limit) > 1_000
    ) {
      violations.push({ code: "INVALID_SIZE_EXCEPTION", path, detail: "limit must be 601..1000" });
      continue;
    }
    if (typeof candidate.owner !== "string" || candidate.owner.trim().length < 3) {
      violations.push({ code: "INVALID_SIZE_EXCEPTION", path, detail: "owner is required" });
      continue;
    }
    if (typeof candidate.reason !== "string" || candidate.reason.trim().length < 40) {
      violations.push({ code: "INVALID_SIZE_EXCEPTION", path, detail: "reason is too short" });
      continue;
    }
    if (exceptions.has(candidate.path)) {
      violations.push({
        code: "DUPLICATE_SIZE_EXCEPTION",
        path: candidate.path,
        detail: "duplicate",
      });
      continue;
    }
    const exception = candidate as unknown as ArchitectureException;
    exceptions.set(exception.path, exception);
  }
  for (const exception of exceptions.values()) {
    const file = filesByPath.get(exception.path);
    if (!file) {
      violations.push({
        code: "SIZE_EXCEPTION_PATH_MISSING",
        path: exception.path,
        detail: "not production source",
      });
      continue;
    }
    const lines = sourceLineCount(file.source);
    if (lines <= 600) {
      violations.push({
        code: "STALE_SIZE_EXCEPTION",
        path: exception.path,
        detail: `${lines}<=600`,
      });
    }
  }
  for (const file of files) {
    const lines = sourceLineCount(file.source);
    if (lines <= 600) continue;
    const exception = exceptions.get(file.path);
    if (!exception) {
      violations.push({
        code: isSqlHeavy(file) ? "SQL_HEAVY_EXCEPTION_REQUIRED" : "SOURCE_SIZE_LIMIT",
        path: file.path,
        detail: `${lines}>600`,
      });
      continue;
    }
    if (lines > exception.limit) {
      violations.push({
        code: "SIZE_EXCEPTION_EXCEEDED",
        path: file.path,
        detail: `${lines}>${exception.limit}`,
      });
    }
  }
  return violations;
}

export function readArchitectureExceptions(repositoryRoot: string): unknown {
  return JSON.parse(readFileSync(resolve(repositoryRoot, "architecture-exceptions.json"), "utf8"));
}
