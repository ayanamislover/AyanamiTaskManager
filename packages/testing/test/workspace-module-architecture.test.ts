import { describe, expect, it } from "vitest";
import {
  auditImportArchitecture,
  collectRepositorySources,
  DEFAULT_WORKSPACE_DEPENDENCIES,
  type ProductionSourceFile,
  type SourceInventory,
  type WorkspacePackage,
} from "./support/architecture-policy.js";

const repositoryRoot = process.cwd();

function fixture(
  files: Array<Pick<ProductionSourceFile, "path" | "packageName" | "source">>,
  packages: WorkspacePackage[],
): SourceInventory {
  return { files, packages };
}

describe("workspace Module import architecture", () => {
  it("扫描全部 production Adapter，workspace 与文件 import graph 零违规", () => {
    const inventory = collectRepositorySources(repositoryRoot);
    const report = auditImportArchitecture(inventory);
    expect(report.fileCount).toBeGreaterThanOrEqual(160);
    expect(report.importCount).toBeGreaterThanOrEqual(800);
    expect(report.packageCount).toBe(14);
    expect(report.violations).toEqual([]);
  });

  it("反向依赖、私有深层 import 与漏声明依赖都会验红", () => {
    const packages: WorkspacePackage[] = [
      { name: "@ayanami-task/errors", root: "packages/errors", declaredDependencies: [] },
      {
        name: "@ayanami-task/domain",
        root: "packages/domain",
        declaredDependencies: ["@ayanami-task/errors"],
      },
      { name: "@ayanami-task/application", root: "packages/application", declaredDependencies: [] },
    ];
    const base = [
      {
        path: "packages/errors/src/index.ts",
        packageName: "@ayanami-task/errors",
        source: "export {};",
      },
      {
        path: "packages/domain/src/index.ts",
        packageName: "@ayanami-task/domain",
        source: "export {};",
      },
      {
        path: "packages/application/src/index.ts",
        packageName: "@ayanami-task/application",
        source: "export {};",
      },
    ];
    const policy = {
      "@ayanami-task/errors": [],
      "@ayanami-task/domain": ["@ayanami-task/errors"],
      "@ayanami-task/application": [],
    };
    expect(
      auditImportArchitecture(
        fixture(
          [
            ...base,
            {
              path: "packages/domain/src/bad.ts",
              packageName: "@ayanami-task/domain",
              source: 'import type { App } from "@ayanami-task/application";',
            },
          ],
          packages,
        ),
        policy,
      ).violations.map((entry) => entry.code),
    ).toEqual(
      expect.arrayContaining(["FORBIDDEN_PACKAGE_IMPORT", "UNDECLARED_WORKSPACE_DEPENDENCY"]),
    );

    expect(
      auditImportArchitecture(
        fixture(
          [
            ...base,
            {
              path: "packages/domain/src/private.ts",
              packageName: "@ayanami-task/domain",
              source: 'import { AtmError } from "@ayanami-task/errors/src/index.js";',
            },
          ],
          packages,
        ),
        policy,
      ).violations.map((entry) => entry.code),
    ).toContain("PACKAGE_PRIVATE_IMPORT");
  });

  it("跨 package 相对路径、literal require 与虚假 runtime 声明都会验红", () => {
    const packages: WorkspacePackage[] = [
      { name: "@ayanami-task/domain", root: "packages/domain", declaredDependencies: [] },
      {
        name: "@ayanami-task/application",
        root: "packages/application",
        declaredDependencies: [],
      },
    ];
    const policy = {
      "@ayanami-task/domain": [],
      "@ayanami-task/application": [],
    };
    const base = [
      {
        path: "packages/domain/src/index.ts",
        packageName: "@ayanami-task/domain",
        source: "export {};",
      },
      {
        path: "packages/application/src/index.ts",
        packageName: "@ayanami-task/application",
        source: "export {};",
      },
    ];
    const crossRelative = auditImportArchitecture(
      fixture(
        [
          ...base,
          {
            path: "packages/domain/src/bad.ts",
            packageName: "@ayanami-task/domain",
            source: 'import "../../application/src/index.js";',
          },
        ],
        packages,
      ),
      policy,
    );
    expect(crossRelative.violations.map((entry) => entry.code)).toContain(
      "CROSS_PACKAGE_RELATIVE_IMPORT",
    );

    const literalRequire = auditImportArchitecture(
      fixture(
        [
          ...base,
          {
            path: "packages/domain/src/require.ts",
            packageName: "@ayanami-task/domain",
            source: 'const application = require("@ayanami-task/application");',
          },
        ],
        packages,
      ),
      policy,
    );
    expect(literalRequire.violations.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["FORBIDDEN_PACKAGE_IMPORT", "UNDECLARED_WORKSPACE_DEPENDENCY"]),
    );

    const declaredButUnused = auditImportArchitecture(
      fixture(base, [
        { ...packages[0]!, declaredDependencies: ["@ayanami-task/application"] },
        packages[1]!,
      ]),
      policy,
    );
    expect(declaredButUnused.violations.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "DECLARED_DEPENDENCY_OUTSIDE_POLICY",
        "UNUSED_RUNTIME_WORKSPACE_DEPENDENCY",
      ]),
    );
    const allowedButUnused = auditImportArchitecture(fixture(base, packages), {
      "@ayanami-task/domain": ["@ayanami-task/application"],
      "@ayanami-task/application": [],
    });
    expect(allowedButUnused.violations.map((entry) => entry.code)).toContain(
      "UNUSED_ALLOWED_DEPENDENCY",
    );
  });

  it("policy 与 import 不能把不存在的 workspace package 伪装成合法依赖", () => {
    const ghost = "@ayanami-task/ghost";
    const report = auditImportArchitecture(
      fixture(
        [
          {
            path: "packages/domain/src/index.ts",
            packageName: "@ayanami-task/domain",
            source: `import "${ghost}";`,
          },
        ],
        [
          {
            name: "@ayanami-task/domain",
            root: "packages/domain",
            declaredDependencies: [ghost],
          },
        ],
      ),
      { "@ayanami-task/domain": [ghost] },
    );
    expect(report.violations.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["PACKAGE_POLICY_TARGET_MISSING", "WORKSPACE_PACKAGE_NOT_FOUND"]),
    );
  });

  it("公开 package subpath 可用，未导出的 src 深层路径会验红", () => {
    const packages: WorkspacePackage[] = [
      {
        name: "@ayanami-task/ui",
        root: "packages/ui",
        declaredDependencies: [],
        publicSpecifiers: ["@ayanami-task/ui", "@ayanami-task/ui/tokens.css"],
      },
      {
        name: "@ayanami-task/desktop",
        root: "apps/desktop",
        declaredDependencies: ["@ayanami-task/ui"],
      },
    ];
    const policy = {
      "@ayanami-task/ui": [],
      "@ayanami-task/desktop": ["@ayanami-task/ui"],
    };
    const target = {
      path: "packages/ui/src/index.ts",
      packageName: "@ayanami-task/ui",
      source: "export {};",
    };
    const publicSubpath = auditImportArchitecture(
      fixture(
        [
          target,
          {
            path: "apps/desktop/src/theme.ts",
            packageName: "@ayanami-task/desktop",
            source: 'import "@ayanami-task/ui/tokens.css";',
          },
        ],
        packages,
      ),
      policy,
    );
    expect(publicSubpath.violations).toEqual([]);

    const privateSubpath = auditImportArchitecture(
      fixture(
        [
          target,
          {
            path: "apps/desktop/src/private.ts",
            packageName: "@ayanami-task/desktop",
            source: 'import "@ayanami-task/ui/src/internal.js";',
          },
        ],
        packages,
      ),
      policy,
    );
    expect(privateSubpath.violations.map((entry) => entry.code)).toContain(
      "PACKAGE_PRIVATE_IMPORT",
    );
  });

  it("runtime、type-only、re-export 与 literal dynamic import 循环都会验红", () => {
    const packages = [
      { name: "@ayanami-task/testing", root: "packages/testing", declaredDependencies: [] },
    ];
    const policy = { "@ayanami-task/testing": [] };
    const cycleCodes = (a: string, b: string) =>
      auditImportArchitecture(
        fixture(
          [
            { path: "packages/testing/src/a.ts", packageName: "@ayanami-task/testing", source: a },
            { path: "packages/testing/src/b.ts", packageName: "@ayanami-task/testing", source: b },
          ],
          packages,
        ),
        policy,
      ).violations.map((entry) => entry.code);

    expect(cycleCodes('import "./b.js";', 'import "./a.js";')).toContain("RUNTIME_IMPORT_CYCLE");
    expect(
      cycleCodes('import type { B } from "./b.js";', 'import type { A } from "./a.js";'),
    ).toContain("TYPE_IMPORT_CYCLE");
    expect(cycleCodes('export * from "./b.js";', 'void import("./a.js");')).toContain(
      "RUNTIME_IMPORT_CYCLE",
    );
    expect(
      cycleCodes('export { type B } from "./b.js";', 'export { type A } from "./a.js";'),
    ).toContain("TYPE_IMPORT_CYCLE");
    expect(cycleCodes('import {} from "./b.js";', 'require("./a.js");')).toContain(
      "RUNTIME_IMPORT_CYCLE",
    );
  });

  it("workspace package 循环与 package self import 都会验红", () => {
    const packages = [
      {
        name: "@ayanami-task/testing-a",
        root: "packages/testing-a",
        declaredDependencies: ["@ayanami-task/testing-b"],
      },
      {
        name: "@ayanami-task/testing-b",
        root: "packages/testing-b",
        declaredDependencies: ["@ayanami-task/testing-a"],
      },
    ];
    const policy = {
      "@ayanami-task/testing-a": ["@ayanami-task/testing-b"],
      "@ayanami-task/testing-b": ["@ayanami-task/testing-a"],
    };
    const cycle = auditImportArchitecture(
      fixture(
        [
          {
            path: "packages/testing-a/src/index.ts",
            packageName: "@ayanami-task/testing-a",
            source: 'import "@ayanami-task/testing-b";',
          },
          {
            path: "packages/testing-b/src/index.ts",
            packageName: "@ayanami-task/testing-b",
            source: 'import "@ayanami-task/testing-a";',
          },
        ],
        packages,
      ),
      policy,
    );
    expect(cycle.violations.map((entry) => entry.code)).toContain("WORKSPACE_IMPORT_CYCLE");

    const selfImport = auditImportArchitecture(
      fixture(
        [
          {
            path: "packages/testing-a/src/index.ts",
            packageName: "@ayanami-task/testing-a",
            source: 'import "@ayanami-task/testing-a";',
          },
        ],
        [packages[0]!],
      ),
      { "@ayanami-task/testing-a": [] },
    );
    expect(selfImport.violations.map((entry) => entry.code)).toContain("PACKAGE_SELF_IMPORT");
  });

  it("AST 不把注释和字符串当 import，且 UI shell 反向访问会验红", () => {
    const packages = [{ name: "@ayanami-task/ui", root: "packages/ui", declaredDependencies: [] }];
    const policy = { "@ayanami-task/ui": [] };
    const clean = auditImportArchitecture(
      fixture(
        [
          {
            path: "packages/ui/src/shell/safe.ts",
            packageName: "@ayanami-task/ui",
            source: 'const note = `import "../features/task.js"`; // import "../routes/app.js"',
          },
        ],
        packages,
      ),
      policy,
    );
    expect(clean.importCount).toBe(0);
    expect(clean.violations).toEqual([]);
    const red = auditImportArchitecture(
      fixture(
        [
          {
            path: "packages/ui/src/shell/bad.ts",
            packageName: "@ayanami-task/ui",
            source: 'import "../features/task.js";',
          },
          {
            path: "packages/ui/src/features/task.ts",
            packageName: "@ayanami-task/ui",
            source: "export {};",
          },
        ],
        packages,
      ),
      policy,
    );
    expect(red.violations.map((entry) => entry.code)).toContain("UI_SEAM_VIOLATION");
    const rootLevelRed = auditImportArchitecture(
      fixture(
        [
          {
            path: "packages/ui/src/shell/bad-root.ts",
            packageName: "@ayanami-task/ui",
            source: 'import "../mcp-bridge-panel.js";',
          },
          {
            path: "packages/ui/src/mcp-bridge-panel.tsx",
            packageName: "@ayanami-task/ui",
            source: "export {};",
          },
        ],
        packages,
      ),
      policy,
    );
    expect(rootLevelRed.violations.map((entry) => entry.code)).toContain("UI_SEAM_VIOLATION");
    for (const [path, source] of [
      ["packages/ui/src/hooks/bad.ts", 'import "../features/task.js";'],
      ["packages/ui/src/contracts.ts", 'import "./features/task.js";'],
    ] as const) {
      const indirectRed = auditImportArchitecture(
        fixture(
          [
            { path, packageName: "@ayanami-task/ui", source },
            {
              path: "packages/ui/src/features/task.ts",
              packageName: "@ayanami-task/ui",
              source: "export {};",
            },
          ],
          packages,
        ),
        policy,
      );
      expect(indirectRed.violations.map((entry) => entry.code)).toContain("UI_SEAM_VIOLATION");
    }
  });

  it("canonical policy 必须与全部14个生产 package 一一对应，防止空扫描", () => {
    const inventory = collectRepositorySources(repositoryRoot);
    expect(inventory.packages.map((entry) => entry.name).sort()).toEqual(
      Object.keys(DEFAULT_WORKSPACE_DEPENDENCIES).sort(),
    );
  });
});
