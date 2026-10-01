import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildThirdPartyNotices,
  NODE_LICENSE_PENDING,
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

  it("打包写入声明并列为必需项；组装候选时拒绝待补的 Node 许可证", () => {
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
    expect(assembler).toContain('readFileSync(notices, "utf8").includes(NODE_LICENSE_PENDING)');
    expect(assembler.indexOf("RELEASE_NOTICES_INCOMPLETE")).toBeLessThan(
      assembler.indexOf("await rm(releaseDir"),
    );
  });
});
