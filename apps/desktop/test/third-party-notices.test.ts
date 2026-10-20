import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { packageOfModule, rendererPackages } from "../scripts/renderer-packages.js";
import {
  buildSbom,
  buildThirdPartyNotices,
  LICENSE_TEXT_PENDING,
  npmComponents,
  releaseNoticesStatus,
  renderThirdPartyNotices,
} from "../../../scripts/third-party-notices.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const scratch = resolve(process.cwd(), "output");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "atm-notices-"));
  temporary.push(root);
  return root;
}

// 二进制分发要随附第三方许可证：链接进原生程序的 crate、renderer bundle 里实际打进去的 npm 包。
// 3.0 的包里没有 Node（W8a），不再有 Node 运行时一节。
describe("第三方许可证声明", () => {
  beforeAll(() => {
    // 真实依赖图那一条要 renderer 的打包清单：构建一次（约 2 秒），与打包走同一份 vite 配置。
    // 先删掉上一次的清单：插件没接上时这里留下的旧文件会让下面照样绿。
    rmSync(join(process.cwd(), "apps", "desktop", "dist", "renderer-packages.json"), {
      force: true,
    });
    execFileSync(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "build", "--config", "apps/desktop/vite.config.ts"],
      { cwd: process.cwd(), stdio: "ignore", windowsHide: true },
    );
  }, 120_000);

  it("包里自带许可证文件就收原文；只声明 MIT 没带文件的按作者补标准 MIT 文本；都没有的留待补标记", () => {
    const text = renderThirdPartyNotices({
      components: [
        {
          ecosystem: "cargo",
          name: "with-file",
          version: "1.0.0",
          license: "MIT OR Apache-2.0",
          authors: [],
          texts: [{ file: "LICENSE-MIT", text: "Copyright (c) Someone" }],
        },
        {
          ecosystem: "npm",
          name: "bare-mit",
          version: "9.0.0",
          license: "MIT",
          authors: ["Jane Doe"],
          texts: [],
        },
      ],
    });
    expect(text).toContain("with-file 1.0.0 (cargo) — MIT OR Apache-2.0");
    expect(text).toContain("--- LICENSE-MIT ---\nCopyright (c) Someone");
    expect(text).toContain("Copyright (c) Jane Doe");
    expect(text).toContain("Permission is hereby granted");
    expect(text).not.toContain(LICENSE_TEXT_PENDING);
    expect(text).not.toMatch(/Node\.js/u);
    const bare = renderThirdPartyNotices({
      components: [
        {
          ecosystem: "npm",
          name: "bare-bsd",
          version: "1.0.0",
          license: "BSD-3-Clause",
          authors: [],
          texts: [],
        },
      ],
    });
    expect(bare).toContain(`${LICENSE_TEXT_PENDING}: no license file is shipped in this package`);
  });

  it("真实依赖图：五个 exe 的 crate、renderer bundle 里的 npm 包都在，每一项都有许可文本", () => {
    const text = buildThirdPartyNotices(process.cwd());
    for (const heading of [
      /^wry \S+ \(cargo\)/mu,
      /^tao \S+ \(cargo\)/mu,
      /^serde_json \S+ \(cargo\)/mu,
      /^zip \S+ \(cargo\)/mu,
      // atm.exe 与宿主都静态链接 SQLite。
      /^libsqlite3-sys \S+ \(cargo\)/mu,
      // atm.exe 与 atm-mcp 的回环探活。
      /^socket2 \S+ \(cargo\)/mu,
      /^react \S+ \(npm\)/mu,
      /^react-dom \S+ \(npm\)/mu,
      /^@tanstack\/react-query \S+ \(npm\)/mu,
    ])
      expect(text).toMatch(heading);
    // 只给 2.x core 用的 npm 包不在 3.0 的包里，不该列。
    for (const absent of [
      /^fastify /mu,
      /^better-sqlite3 /mu,
      /^@modelcontextprotocol\/sdk /mu,
      /^commander /mu,
    ])
      expect(text).not.toMatch(absent);
    // 本仓自己的 crate 与 workspace 包不是第三方。
    expect(text).not.toMatch(/^atm-(?:host|setup|launcher|install-state|mcp|cli) /mu);
    expect(text).not.toMatch(/^@ayanami-task\//mu);
    // 没有许可文本、也补不上标准 MIT 的组件要人工核对；现在一个都不能有。
    expect(text).not.toContain(LICENSE_TEXT_PENDING);
  });

  it("bundle 的模块 id 归到包：pnpm 的 .pnpm 目录、scope 包、虚拟模块与查询串", () => {
    expect(packageOfModule("R:/x/node_modules/.pnpm/react@19/node_modules/react/index.js")).toEqual(
      { name: "react", dir: "R:/x/node_modules/.pnpm/react@19/node_modules/react" },
    );
    expect(
      packageOfModule(
        "\0R:\\x\\node_modules\\@tanstack\\query-core\\build\\a.js?commonjs-es-import",
      ),
    ).toEqual({ name: "@tanstack/query-core", dir: "R:/x/node_modules/@tanstack/query-core" });
    expect(packageOfModule("R:/x/apps/desktop/src/main.tsx")).toBeNull();
    expect(packageOfModule("\0commonjsHelpers.js")).toBeNull();
    expect(
      rendererPackages(
        [
          "R:/x/node_modules/react/index.js",
          "R:/x/node_modules/react/cjs/react.production.js",
          "R:/x/packages/ui/src/a.ts",
        ],
        "R:/x",
      ),
    ).toEqual([{ name: "react", dir: "node_modules/react" }]);
  });

  it("npm 按 renderer 的打包清单收；清单缺了或列的包不在都报错，不拿空集当没有", () => {
    const root = fixtureRoot();
    expect(() => npmComponents(root)).toThrow(/NOTICES_RENDERER_PACKAGES_MISSING/u);
    const dist = join(root, "apps", "desktop", "dist");
    mkdirSync(dist, { recursive: true });
    mkdirSync(join(root, "node_modules", "bundled"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "bundled", "package.json"),
      JSON.stringify({ name: "bundled", version: "1.0.0", license: "MIT" }),
    );
    writeFileSync(join(root, "node_modules", "bundled", "LICENSE"), "license of bundled");
    const listing = (entries: object[]) =>
      writeFileSync(join(dist, "renderer-packages.json"), JSON.stringify(entries));
    listing([{ name: "bundled", dir: "node_modules/bundled" }]);
    expect(npmComponents(root)).toMatchObject([
      {
        name: "bundled",
        version: "1.0.0",
        texts: [{ file: "LICENSE", text: "license of bundled" }],
      },
    ]);
    listing([{ name: "gone", dir: "node_modules/gone" }]);
    expect(() => npmComponents(root)).toThrow(/NOTICES_DEPENDENCY_MISSING: gone/u);
  });

  it("从将要发出去的归档里核声明：两份 zip 一致、与清单哈希相同，没有待补标记才可分发", () => {
    const complete = strToU8("notices\nlicense text\n");
    const pending = strToU8(`notices\n${LICENSE_TEXT_PENDING}: missing\n`);
    const archives = (inPackage: Uint8Array, inPortable = inPackage, listed = inPackage) => ({
      packageZip: zipSync({ "THIRD_PARTY_NOTICES.txt": inPackage, LICENSE: strToU8("x") }),
      portableZip: zipSync({
        "Atm-1/THIRD_PARTY_NOTICES.txt": inPortable,
        "Atm-1/portable": strToU8(""),
      }),
      portableFolder: "Atm-1",
      manifestFiles: [
        {
          path: "THIRD_PARTY_NOTICES.txt",
          sha256: createHash("sha256").update(listed).digest("hex"),
        },
      ],
    });
    expect(releaseNoticesStatus(archives(complete)).distributable).toBe(true);
    expect(releaseNoticesStatus(archives(pending)).distributable).toBe(false);
    // 旁边的松散目录补好了也没用：归档里是待补的，就不可分发。
    expect(() => releaseNoticesStatus(archives(complete, pending))).toThrow(
      /RELEASE_NOTICES_MISMATCH/u,
    );
    expect(() => releaseNoticesStatus(archives(complete, complete, pending))).toThrow(
      /RELEASE_NOTICES_MISMATCH/u,
    );
    expect(() =>
      releaseNoticesStatus({ ...archives(complete), packageZip: zipSync({ LICENSE: complete }) }),
    ).toThrow(/RELEASE_NOTICES_MISSING/u);
  });

  it("打包写入声明并列为必需项；不可分发的候选只能本机组装，发布入口拒绝", () => {
    const packageNative = readFileSync("scripts/package-native.ts", "utf8");
    expect(packageNative).toContain(
      'writeFileSync(join(appDir, THIRD_PARTY_NOTICES), buildThirdPartyNotices(root), "utf8");',
    );
    expect(packageNative.indexOf("buildThirdPartyNotices(root)")).toBeLessThan(
      packageNative.indexOf("missingRequiredPackagedEntries(payload)"),
    );
    expect(readFileSync("scripts/package-content-policy.ts", "utf8")).toContain(
      '"THIRD_PARTY_NOTICES.txt",',
    );
    const assembler = readFileSync("scripts/assemble-release.ts", "utf8");
    expect(assembler).toContain("packageZip: readFileSync(join(packageDir, packageName)),");
    expect(assembler).toContain("if (!notices.distributable && !localOnly)");
    expect(assembler).toContain("distributable: notices.distributable,");
    expect(assembler.indexOf("RELEASE_NOTICES_INCOMPLETE")).toBeLessThan(
      assembler.indexOf("await rm(releaseDir"),
    );
    // 本机一条命令走 --local-only；CI 的发布校验不走；发布脚本只收可分发的候选。
    expect(readFileSync("scripts/release-and-install.ts", "utf8")).toContain(
      '"pnpm exec tsx scripts/release.ts --local-only"',
    );
    expect(readFileSync(".github/workflows/windows-release-validation.yml", "utf8")).not.toContain(
      "--local-only",
    );
    expect(readFileSync(".github/scripts/publish-verified-release.mjs", "utf8")).toContain(
      'assert.equal(manifest.distributable, true, "Candidate is not distributable");',
    );
  });
});

// SBOM 列的是包里实际有的东西：链接进 exe 的 Rust crate 与 renderer 里的 npm 包，和 notices
// 同一份清单。package.json 的依赖表大半是构建与测试用的开发依赖，3.0 的包里没有 Node。
describe("SBOM", () => {
  const components = [
    { ecosystem: "npm" as const, name: "@scope/ui-kit", version: "1.2.0", license: "MIT" },
    {
      ecosystem: "cargo" as const,
      name: "serde",
      version: "1.0.200",
      license: "MIT OR Apache-2.0",
    },
    {
      ecosystem: "cargo" as const,
      name: "windows-sys",
      version: "0.59.0",
      license: "MIT/Apache-2.0",
    },
    { ecosystem: "cargo" as const, name: "odd", version: "0.1.0", license: "(see license file)" },
  ];
  const sbom = buildSbom({
    product: "AyanamiTaskManager",
    version: "8.1.2",
    license: "AGPL-3.0-only",
    namespace: "https://ayanami.local/spdx/x/8.1.2/abc",
    created: "2026-10-11T00:00:00Z",
    components,
  }) as {
    spdxVersion: string;
    packages: Array<{
      name: string;
      SPDXID: string;
      versionInfo: string;
      licenseDeclared: string;
      externalRefs?: Array<{ referenceLocator: string }>;
    }>;
    relationships: Array<{
      spdxElementId: string;
      relationshipType: string;
      relatedSpdxElement: string;
    }>;
  };

  it("产品之外逐个列出 crate 与 npm 包，带 purl，产品 CONTAINS 每一个", () => {
    expect(sbom.spdxVersion).toBe("SPDX-2.3");
    const [product, ...rest] = sbom.packages;
    expect(product).toMatchObject({
      name: "AyanamiTaskManager",
      versionInfo: "8.1.2",
      licenseDeclared: "AGPL-3.0-only",
    });
    expect(rest.map((entry) => entry.externalRefs?.[0]?.referenceLocator)).toEqual([
      "pkg:cargo/odd@0.1.0",
      "pkg:cargo/serde@1.0.200",
      "pkg:cargo/windows-sys@0.59.0",
      "pkg:npm/%40scope/ui-kit@1.2.0",
    ]);
    expect(new Set(rest.map((entry) => entry.SPDXID)).size).toBe(rest.length);
    for (const id of rest.map((entry) => entry.SPDXID))
      expect(id).toMatch(/^SPDXRef-[A-Za-z0-9.-]+$/u);
    expect(sbom.relationships).toEqual(
      rest.map((entry) => ({
        spdxElementId: product!.SPDXID,
        relationshipType: "CONTAINS",
        relatedSpdxElement: entry.SPDXID,
      })),
    );
  });

  it("许可证只照写 SPDX 表达式（斜杠写法换成 OR），其余写 NOASSERTION", () => {
    const declared = Object.fromEntries(
      sbom.packages.map((entry) => [entry.name, entry.licenseDeclared]),
    );
    expect(declared).toMatchObject({
      serde: "MIT OR Apache-2.0",
      "windows-sys": "MIT OR Apache-2.0",
      odd: "NOASSERTION",
      "@scope/ui-kit": "MIT",
    });
  });

  it("组装用的是随包分发的组件清单，不读 package.json 的依赖表", () => {
    const assembler = readFileSync("scripts/assemble-release.ts", "utf8");
    expect(assembler).toContain("components: shippedComponents(root),");
    expect(assembler).not.toMatch(/\b(?:dev)?[dD]ependencies\b/u);
  });
});
