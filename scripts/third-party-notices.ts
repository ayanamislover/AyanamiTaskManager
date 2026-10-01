import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 版本目录里的 THIRD_PARTY_NOTICES.txt：随包分发的第三方组件及其许可证原文。
 *
 * 三处来源，各按「实际进了包的」收：
 * - Rust：宿主、根启动器、安装器与 MCP shim 经正常依赖（不含 build/dev 依赖）链接进来的 crate，
 *   取自 `cargo metadata`（--locked、Windows x64 目标），许可证文件取自 crate 源码目录；
 * - npm：core/CLI/renderer 打包进来的生产依赖（根与各 workspace 的 dependencies 及其传递依赖），
 *   许可证文件取自 node_modules；
 * - Node.js 运行时：`third_party/node/LICENSE`，`third_party/node/VERSION` 必须等于随包的版本。
 *   缺了或版本对不上就写入 NODE_LICENSE_PENDING——包照样能打（本机验收要用），
 *   assemble-release 见到这个标记拒绝组装候选，不会发出去。
 */
export const THIRD_PARTY_NOTICES = "THIRD_PARTY_NOTICES.txt";
export const NODE_LICENSE_PENDING = "NODE_LICENSE_PENDING";

type Component = {
  ecosystem: "cargo" | "npm";
  name: string;
  version: string;
  license: string;
  authors: string[];
  texts: Array<{ file: string; text: string }>;
};

/**
 * 少数 MIT 包的发行物里没带许可证文件。MIT 要求随附版权声明与许可文本，这里按包声明的作者
 * 补上标准 MIT 文本；其他许可证没有文件时只写声明，由内容守卫列出来人工核对。
 */
function standardMit(authors: readonly string[]): string {
  return [
    `Copyright (c) ${authors.length > 0 ? authors.join(", ") : "the package authors"}`,
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy of this software",
    'and associated documentation files (the "Software"), to deal in the Software without',
    "restriction, including without limitation the rights to use, copy, modify, merge, publish,",
    "distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the",
    "Software is furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all copies or",
    "substantial portions of the Software.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING',
    "BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND",
    "NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,",
    "DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
  ].join("\n");
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:[-._].*)?$/iu;

function licenseTexts(directory: string): Array<{ file: string; text: string }> {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((file) => ({
      file,
      text: readFileSync(join(directory, file), "utf8").replace(/\r\n/gu, "\n").trimEnd(),
    }));
}

type CargoMetadata = {
  packages: Array<{
    id: string;
    name: string;
    version: string;
    license: string | null;
    license_file: string | null;
    authors: string[];
    manifest_path: string;
    source: string | null;
  }>;
  resolve: {
    nodes: Array<{
      id: string;
      deps: Array<{ pkg: string; dep_kinds: Array<{ kind: string | null }> }>;
    }>;
  };
};

/** 从给定 crate 出发，沿正常依赖收集所有非本地 crate。 */
export function cargoComponents(workspace: string, roots: readonly string[]): Component[] {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--locked",
        "--filter-platform",
        "x86_64-pc-windows-msvc",
      ],
      { cwd: workspace, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    ),
  ) as CargoMetadata;
  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const pending = metadata.packages
    .filter((entry) => roots.includes(entry.name))
    .map((entry) => entry.id);
  if (pending.length !== roots.length)
    throw new Error(`NOTICES_CARGO_ROOT_MISSING: ${roots.join(",")}`);
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? [])
      if (dep.dep_kinds.some((kind) => kind.kind === null)) pending.push(dep.pkg);
  }
  return [...seen]
    .map((id) => packages.get(id)!)
    .filter((entry) => entry.source !== null)
    .map((entry) => {
      const directory = dirname(entry.manifest_path);
      const texts = licenseTexts(directory);
      if (entry.license_file && !texts.some((text) => text.file === entry.license_file)) {
        const path = resolve(directory, entry.license_file);
        if (existsSync(path))
          texts.push({ file: entry.license_file, text: readFileSync(path, "utf8").trimEnd() });
      }
      return {
        ecosystem: "cargo" as const,
        name: entry.name,
        version: entry.version,
        license: entry.license ?? "(see license file)",
        authors: entry.authors,
        texts,
      };
    });
}

type PackageJson = {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  author?: string | { name?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function packageDirectory(name: string, from: string, root: string): string | null {
  for (let current = from; ; current = dirname(current)) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (resolve(current) === resolve(root) || dirname(current) === current) return null;
  }
}

/** 根与各 workspace 的生产依赖（排除本仓自己的 @ayanami-task/*）及其传递依赖。 */
export function npmComponents(root: string): Component[] {
  const manifests = [
    join(root, "package.json"),
    ...["apps", "packages"].flatMap((group) =>
      readdirSync(join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, group, entry.name, "package.json"))
        .filter((path) => existsSync(path)),
    ),
  ];
  const pending: Array<[string, string]> = manifests.flatMap((manifest) =>
    Object.keys((JSON.parse(readFileSync(manifest, "utf8")) as PackageJson).dependencies ?? {})
      .filter((name) => !name.startsWith("@ayanami-task/"))
      .map((name): [string, string] => [name, dirname(manifest)]),
  );
  const found = new Map<string, Component>();
  while (pending.length > 0) {
    const [name, from] = pending.pop()!;
    const directory = packageDirectory(name, from, root);
    if (!directory) continue; // 未安装的可选依赖（别的平台的预编译包）
    const manifest = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    ) as PackageJson;
    const key = `${name}@${manifest.version ?? "?"}`;
    if (found.has(key)) continue;
    const license =
      typeof manifest.license === "string"
        ? manifest.license
        : (manifest.license?.type ?? "(see license file)");
    found.set(key, {
      ecosystem: "npm",
      name,
      version: manifest.version ?? "?",
      license,
      authors:
        typeof manifest.author === "string"
          ? [manifest.author]
          : manifest.author?.name
            ? [manifest.author.name]
            : [],
      texts: licenseTexts(directory),
    });
    for (const dependency of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ])
      pending.push([dependency, directory]);
  }
  return [...found.values()];
}

function nodeSection(root: string, nodeVersion: string): string {
  const license = join(root, "third_party", "node", "LICENSE");
  const versionFile = join(root, "third_party", "node", "VERSION");
  const recorded = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : null;
  const heading = `Node.js ${nodeVersion} (runtime\\atm-core.exe) — MIT and bundled third-party licenses`;
  if (!existsSync(license) || recorded !== nodeVersion)
    return `${heading}\n\n${NODE_LICENSE_PENDING}: third_party/node/LICENSE for ${nodeVersion} is not in the repository (VERSION: ${recorded ?? "missing"}).`;
  return `${heading}\n\n${readFileSync(license, "utf8").replace(/\r\n/gu, "\n").trimEnd()}`;
}

export function renderThirdPartyNotices(input: {
  root: string;
  nodeVersion: string;
  components: readonly Component[];
}): string {
  const rule = "=".repeat(78);
  const sorted = [...input.components].sort(
    (left, right) =>
      left.ecosystem.localeCompare(right.ecosystem) ||
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version),
  );
  const sections = [
    nodeSection(input.root, input.nodeVersion),
    ...sorted.map((component) => {
      const head = `${component.name} ${component.version} (${component.ecosystem}) — ${component.license}`;
      const body =
        component.texts.length > 0
          ? component.texts.map((text) => `--- ${text.file} ---\n${text.text}`).join("\n\n")
          : component.license === "MIT"
            ? `--- MIT (the package ships no license file) ---\n${standardMit(component.authors)}`
            : "No license file is shipped in this package; its declared license is stated above.";
      return `${head}\n\n${body}`;
    }),
  ];
  return (
    "AyanamiTaskManager — third-party notices\n\n" +
    "AyanamiTaskManager itself is licensed under AGPL-3.0-only (see LICENSE). It ships the\n" +
    "components below; each is listed with its declared license and the license files from\n" +
    "its own distribution.\n\n" +
    sections.map((section) => `${rule}\n${section}\n`).join("\n")
  );
}

export function buildThirdPartyNotices(root: string, nodeVersion = process.version): string {
  const native = join(root, "apps", "desktop", "native");
  const components = [
    ...cargoComponents(native, ["atm-host", "atm-launcher", "atm-setup"]),
    ...cargoComponents(join(native, "mcp-shim"), ["atm-mcp"]),
    ...npmComponents(root),
  ];
  const unique = new Map(
    components.map((entry) => [`${entry.ecosystem}:${entry.name}@${entry.version}`, entry]),
  );
  return renderThirdPartyNotices({ root, nodeVersion, components: [...unique.values()] });
}
