import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildThirdPartyNotices,
  NODE_LICENSE_PENDING,
  npmComponents,
  releaseNoticesStatus,
  renderThirdPartyNotices,
} from "../../../scripts/third-party-notices.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureRoot(nodeLicense?: { version: string; text: string }): string {
  const root = mkdtempSync(join(tmpdir(), "atm-notices-"));
  temporary.push(root);
  if (nodeLicense) {
    mkdirSync(join(root, "third_party", "node"), { recursive: true });
    writeFileSync(join(root, "third_party", "node", "VERSION"), `${nodeLicense.version}\n`, "utf8");
    writeFileSync(join(root, "third_party", "node", "LICENSE"), nodeLicense.text, "utf8");
  }
  return root;
}

// 二进制分发要随附第三方许可证：随包的 Node、静态链接的 crate、打包进 core/renderer 的 npm 依赖。
describe("第三方许可证声明", () => {
  it("缺 Node 许可证或版本对不上时写入待补标记，对上了就收原文", () => {
    const components = [] as const;
    expect(
      renderThirdPartyNotices({ root: fixtureRoot(), nodeVersion: "v9.9.9", components }),
    ).toContain(NODE_LICENSE_PENDING);
    expect(
      renderThirdPartyNotices({
        root: fixtureRoot({ version: "v9.9.8", text: "Node license text" }),
        nodeVersion: "v9.9.9",
        components,
      }),
    ).toContain(NODE_LICENSE_PENDING);
    const complete = renderThirdPartyNotices({
      root: fixtureRoot({ version: "v9.9.9", text: "Node license text" }),
      nodeVersion: "v9.9.9",
      components,
    });
    expect(complete).not.toContain(NODE_LICENSE_PENDING);
    expect(complete).toContain("Node license text");
  });

  it("包里自带许可证文件就收原文；只声明 MIT 没带文件的按作者补标准 MIT 文本", () => {
    const text = renderThirdPartyNotices({
      root: fixtureRoot(),
      nodeVersion: "v9.9.9",
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
          version: "2.0.0",
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
  });

  it("真实依赖图：宿主与 shim 的 crate、core/renderer 的 npm 依赖都在，每一项都有许可文本", () => {
    const text = buildThirdPartyNotices(process.cwd());
    for (const heading of [
      /^wry \S+ \(cargo\)/mu,
      /^tao \S+ \(cargo\)/mu,
      /^serde_json \S+ \(cargo\)/mu,
      /^zip \S+ \(cargo\)/mu,
      /^react \S+ \(npm\)/mu,
      /^fastify \S+ \(npm\)/mu,
      /^better-sqlite3 \S+ \(npm\)/mu,
      /^@modelcontextprotocol\/sdk \S+ \(npm\)/mu,
    ])
      expect(text).toMatch(heading);
    // 本仓自己的 crate 与 workspace 包不是第三方。
    expect(text).not.toMatch(/^atm-(?:host|setup|launcher|install-state|mcp) /mu);
    expect(text).not.toMatch(/^@ayanami-task\//mu);
    // 没有许可文本、也补不上标准 MIT 的组件要人工核对；现在一个都不能有。
    expect(text).not.toContain("No license file is shipped in this package");
  });

  it("npm：装了的 peer 依赖要收；必需依赖没装要报错，可选的没装跳过", () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "apps"));
    mkdirSync(join(root, "packages"));
    const write = (path: string, manifest: object) => {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, "package.json"), JSON.stringify(manifest), "utf8");
      writeFileSync(join(root, path, "LICENSE"), `license of ${path}`, "utf8");
    };
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { host: "1.0.0" } }),
      "utf8",
    );
    write("node_modules/host", {
      name: "host",
      version: "1.0.0",
      peerDependencies: { "runtime-peer": "*", "absent-peer": "*" },
      optionalDependencies: { "other-platform": "*" },
    });
    write("node_modules/runtime-peer", { name: "runtime-peer", version: "2.0.0" });
    expect(
      npmComponents(root)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["host", "runtime-peer"]);
    write("node_modules/host", {
      name: "host",
      version: "1.0.0",
      dependencies: { "broken-required": "*" },
    });
    expect(() => npmComponents(root)).toThrow(/NOTICES_DEPENDENCY_MISSING: broken-required/u);
  });

  it("从将要发出去的归档里核声明：两份 zip 一致、与清单哈希相同，没有待补标记才可分发", () => {
    const complete = strToU8("notices\nNode license text\n");
    const pending = strToU8(`notices\n${NODE_LICENSE_PENDING}: missing\n`);
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
