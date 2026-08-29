import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("open-source repository guardrails", () => {
  it("publishes the required community and licensing documents", () => {
    const license = read("LICENSE");
    const readme = read("README.md");
    const packageJson = JSON.parse(read("package.json")) as {
      license?: string;
      repository?: { url?: string };
    };

    expect(license).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3, 19 November 2007");
    expect(packageJson.license).toBe("AGPL-3.0-only");
    expect(packageJson.repository?.url).toBe(
      "git+https://github.com/ayanamislover/AyanamiTaskManager.git",
    );
    for (const link of [
      "./LICENSE",
      "./SECURITY.md",
      "./CONTRIBUTING.md",
      "./CODE_OF_CONDUCT.md",
      "./docs/asset-provenance.md",
    ]) {
      expect(readme).toContain(link);
    }
  });

  it("keeps local credentials, runtime state and databases ignored", () => {
    const gitignore = read(".gitignore");
    for (const pattern of [
      ".env",
      "*.pem",
      "*.key",
      "**/runtime/daemon.json",
      "*.sqlite",
      "*.db-wal",
      "*.db-shm",
    ]) {
      expect(gitignore).toContain(pattern);
    }
  });

  it("does not publish maintainer-machine paths in public-facing documents", () => {
    const publicDocuments = [
      "README.md",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "AyanamiTaskManager_Development_Spec_CN_v2.md",
      "docs/feedback-closeout.md",
      "docs/asset-provenance.md",
      "docs/reuse-map.md",
    ];
    const forbidden = [/[A-Z]:\\Users\\[^%]/u, /R:\\Project_All/u];

    for (const path of publicDocuments) {
      const source = read(path);
      for (const pattern of forbidden) {
        expect(source, `${path} contains a developer-machine path`).not.toMatch(pattern);
      }
    }
  });

  it("uses the public default branch for installer icon retrieval", () => {
    const forge = read("forge.config.ts");
    const extraResource = /extraResource:\s*\[([\s\S]*?)\]/u.exec(forge)?.[1] ?? "";
    expect(forge).toContain("refs/heads/main/logo.ico");
    expect(forge).not.toContain("refs/heads/ayanamislover/complete-implementation");
    expect(extraResource).not.toContain('"logo.png"');
    expect(forge).toContain("logo\\.png$");
  });
});
