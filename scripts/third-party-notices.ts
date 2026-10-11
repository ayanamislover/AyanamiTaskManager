import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { RENDERER_PACKAGES_FILE, type RendererPackage } from "./renderer-packages.js";

/**
 * 版本目录里的 THIRD_PARTY_NOTICES.txt：随包分发的第三方组件及其许可证原文。
 *
 * 3.0 的包是单进程、没有 Node（W8a），两处来源，各按「实际进了包的」收：
 * - Rust：宿主、根启动器、安装器、atm.exe 与 MCP shim 经正常依赖（不含 build/dev 依赖）链接进来的
 *   crate，取自 `cargo metadata`（--locked、Windows x64 目标），许可证文件取自 crate 源码目录；
 * - npm：renderer bundle 里实际打进去的包（Vite 构建时记下的 `dist/renderer-packages.json`），
 *   许可证文件取自各自的包目录。
 *
 * 有组件既没有许可文本、又补不上标准 MIT 时写入 LICENSE_TEXT_PENDING——包照样能打（本机验收要用），
 * assemble-release 见到这个标记拒绝组装候选，不会发出去。
 */
export const THIRD_PARTY_NOTICES = "THIRD_PARTY_NOTICES.txt";
export const LICENSE_TEXT_PENDING = "LICENSE_TEXT_PENDING";
/** 链接进包里各个 exe 的工作区 crate（atm-mcp 在 mcp-shim 自己的工作区里）。 */
export const PACKAGED_CRATES = ["atm-host", "atm-launcher", "atm-setup", "atm-cli"] as const;

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
};

/**
 * renderer bundle 里实际打进去的 npm 包（vite.config.ts 构建时写的清单）。没有清单说明 renderer
 * 没构建过——不能拿空集当「没有 npm 组件」。
 */
export function npmComponents(root: string): Component[] {
  const listing = join(root, "apps", "desktop", "dist", RENDERER_PACKAGES_FILE);
  if (!existsSync(listing))
    throw new Error(
      `NOTICES_RENDERER_PACKAGES_MISSING: ${RENDERER_PACKAGES_FILE}（先构建 renderer）`,
    );
  const packages = JSON.parse(readFileSync(listing, "utf8")) as RendererPackage[];
  const found = new Map<string, Component>();
  for (const entry of packages) {
    const directory = resolve(root, entry.dir);
    if (!existsSync(join(directory, "package.json")))
      throw new Error(`NOTICES_DEPENDENCY_MISSING: ${entry.name}（${entry.dir}）`);
    const manifest = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    ) as PackageJson;
    const key = `${entry.name}@${manifest.version ?? "?"}`;
    if (found.has(key)) continue;
    const license =
      typeof manifest.license === "string"
        ? manifest.license
        : (manifest.license?.type ?? "(see license file)");
    found.set(key, {
      ecosystem: "npm",
      name: entry.name,
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
  }
  return [...found.values()];
}

export function renderThirdPartyNotices(input: { components: readonly Component[] }): string {
  const rule = "=".repeat(78);
  const sorted = [...input.components].sort(
    (left, right) =>
      left.ecosystem.localeCompare(right.ecosystem) ||
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version),
  );
  const sections = [
    ...sorted.map((component) => {
      const head = `${component.name} ${component.version} (${component.ecosystem}) — ${component.license}`;
      const body =
        component.texts.length > 0
          ? component.texts.map((text) => `--- ${text.file} ---\n${text.text}`).join("\n\n")
          : component.license === "MIT"
            ? `--- MIT (the package ships no license file) ---\n${standardMit(component.authors)}`
            : `${LICENSE_TEXT_PENDING}: no license file is shipped in this package; its declared license is stated above.`;
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

export function buildThirdPartyNotices(root: string): string {
  const native = join(root, "apps", "desktop", "native");
  const components = [
    ...cargoComponents(native, PACKAGED_CRATES),
    ...cargoComponents(join(native, "mcp-shim"), ["atm-mcp"]),
    ...npmComponents(root),
  ];
  const unique = new Map(
    components.map((entry) => [`${entry.ecosystem}:${entry.name}@${entry.version}`, entry]),
  );
  return renderThirdPartyNotices({ components: [...unique.values()] });
}

export type ReleaseNoticesStatus = { distributable: boolean; sha256: string };

/**
 * 发出去的是归档，不是 output 里旁边那个松散的版本目录：从版本 zip 与便携 zip 里取出
 * notices，两份必须逐字节相同、且等于版本清单逐文件记下的哈希（setup 按清单校验安装）。
 * 没有许可文本待补标记才算可分发。
 */
export function releaseNoticesStatus(input: {
  packageZip: Uint8Array;
  portableZip: Uint8Array;
  portableFolder: string;
  manifestFiles: ReadonlyArray<{ path: string; sha256: string }>;
}): ReleaseNoticesStatus {
  const portableName = `${input.portableFolder}/${THIRD_PARTY_NOTICES}`;
  const inPackage = unzipSync(input.packageZip, {
    filter: (file) => file.name === THIRD_PARTY_NOTICES,
  })[THIRD_PARTY_NOTICES];
  const inPortable = unzipSync(input.portableZip, {
    filter: (file) => file.name === portableName,
  })[portableName];
  if (!inPackage || !inPortable)
    throw new Error(`RELEASE_NOTICES_MISSING: 归档里没有 ${THIRD_PARTY_NOTICES}`);
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const sha256 = hash(inPackage);
  if (hash(inPortable) !== sha256)
    throw new Error("RELEASE_NOTICES_MISMATCH: 版本 zip 与便携 zip 里的声明不同");
  const listed = input.manifestFiles.find((file) => file.path === THIRD_PARTY_NOTICES);
  if (listed?.sha256.toLowerCase() !== sha256)
    throw new Error("RELEASE_NOTICES_MISMATCH: 版本清单记录的声明哈希与归档不符");
  return {
    distributable: !Buffer.from(inPackage).toString("utf8").includes(LICENSE_TEXT_PENDING),
    sha256,
  };
}
