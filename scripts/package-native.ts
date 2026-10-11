/**
 * 生成一个版本的发布产物（de-electron §6 包格式）：
 *
 *   output/package/atm-<v>-win-x64.zip    版本目录 app-<v> 的全部文件
 *   output/package/atm-<v>-win-x64.json   清单：zip 的 sha256/字节数、逐文件 size+sha256、
 *                                          最低 WebView2、schemaSet；最后写，写完才算发布
 *   output/package/atm-setup.exe           安装器；与上面两个放在同一目录就是一个安装包
 *
 *   pnpm exec tsx scripts/package-native.ts                  # 构建全部并打包
 *   pnpm exec tsx scripts/package-native.ts --no-build       # 只重打包已有构建产物
 *   pnpm exec tsx scripts/package-native.ts --smoke <dir>    # 烟测包：宿主带 smoke feature
 *   pnpm exec tsx scripts/package-native.ts --release        # 发布流水线：构建一次，产出
 *       output/package（安装包 + 便携 zip）与 output/package-smoke（烟测包）
 *
 * 产物先落在 output/：发布组装（assemble-release.ts）会清空 release/ 再从这里取。
 *
 * 构建失败一律直接报错，不回落：缺任何一个原生组件的包「看起来能装」，恰恰没交付要交付的东西。
 *
 * 3.0 起包里没有 Node（W8a）：宿主、atm.exe、atm-mcp.exe、根启动器、setup 五个原生 exe 加 renderer。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync, type Zippable } from "fflate";
import { stampAgentGuide } from "../apps/desktop/src/agent-guide-stamp.js";
import { resolveAgentGuideBuild } from "./agent-guide-build.js";
import { APP_LAYOUT, assembleAppDirectory } from "./app-layout.js";
import { writeCandidateBinaries } from "./candidate-binaries.js";
import { buildMcpShim, MCP_SHIM_RELEASE_EXE } from "./mcp-shim-build.js";
import { cargoHome, releaseRustEnv } from "./rust-build-env.js";
import { buildThirdPartyNotices, THIRD_PARTY_NOTICES } from "./third-party-notices.js";
import {
  assertExecutableIdentity,
  assertExecutableVersionResource,
  assertMcpShimVersionResource,
  assertPublishedLogoBytes,
  buildMachinePathNeedles,
  findBuildMachinePath,
  findForbiddenPackagedEntries,
  findTestBuildMarkers,
  missingRequiredPackagedEntries,
  type TestBuild,
} from "./package-content-policy.js";

/**
 * WebView2 Evergreen 自动更新；这个下限覆盖 non-client region（`app-region: drag`）等宿主用到的
 * 能力，低于它 PRECHECK 就拦下，旧版本保持可用。
 */
export const MIN_WEBVIEW2 = "128.0.2739.42";
export const MANIFEST_FORMAT = 1;
/** 版本目录里有这个空文件，宿主就按便携版运行（install-state 的 PORTABLE_MARKER）。 */
export const PORTABLE_MARKER = "portable";
export const NATIVE_CRATE_DIR = "apps/desktop/native";
const FIXED_MTIME = new Date("2026-01-01T00:00:00Z");

export type ManifestFile = { path: string; size: number; sha256: string };
export type NativeManifest = {
  format: number;
  version: string;
  arch: "x64";
  package: string;
  packageSha256: string;
  packageBytes: number;
  unpackedBytes: number;
  minWebView2: string;
  schemaSet: string;
  files: ManifestFile[];
};

export type NativeRelease = {
  version: string;
  dir: string;
  appDir: string;
  zip: string;
  manifest: string;
  setup: string;
};

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): void {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `BUILD_FAILED: ${command} ${args.join(" ")} 退出 ${String(result.status)}` +
        (result.error ? `：${result.error.message}` : ""),
    );
}

export function nativeRelease(root: string): {
  host: string;
  cli: string;
  launcher: string;
  setup: string;
} {
  const target = join(root, NATIVE_CRATE_DIR, "target", "release");
  return {
    host: join(target, "AyanamiTaskManager.exe"),
    cli: join(target, "atm.exe"),
    launcher: join(target, "atm-launcher.exe"),
    setup: join(target, "atm-setup.exe"),
  };
}

/**
 * 演练用 setup：带 `drill` feature（沙箱与故障注入），单独的 target 目录，绝不和发布构建混用。
 * 演练包里必须是这一份——FENCE 会把包里的 setup 拷到安装根，之后宿主和启动器的恢复都调它；
 * 生产版不认沙箱，会去动真实安装。
 */
export function drillSetup(root: string): string {
  return join(root, NATIVE_CRATE_DIR, "target-drill", "release", "atm-setup.exe");
}

/**
 * 烟测用宿主：带 `smoke` feature（WebView2 开 CDP、接受 SMOKE_QUIT），单独的 target 目录。
 * 烟测包只证明行为；发布的是生产宿主，它另有「没有调试入口」的检查（assertProductionHost）。
 */
export function smokeHost(root: string): string {
  return join(root, NATIVE_CRATE_DIR, "target-smoke", "release", "AyanamiTaskManager.exe");
}

/** 烟测脚本拿到的宿主必须真是 smoke 构建：生产宿主没有 CDP 端口，脚本只会空等。 */
export function assertSmokeHost(bytes: Buffer): void {
  if (!findTestBuildMarkers(bytes).includes("smoke:--remote-debugging-port"))
    throw new Error("SMOKE_HOST_WITHOUT_SMOKE_FEATURE");
}

/**
 * 包里每一个 exe 都不能带测试构建的标记（P-012）：生产包一个都不许；烟测包的宿主可以是 smoke，
 * 演练包的 setup 可以是 drill。e2e 在任何包里都不许。
 */
export function assertNoTestBuildMarkers(
  appDir: string,
  payload: readonly string[],
  allowed: Readonly<Record<string, readonly TestBuild[]>> = {},
): void {
  for (const path of payload.filter((entry) => entry.toLowerCase().endsWith(".exe"))) {
    const found = findTestBuildMarkers(readFileSync(join(appDir, path)), allowed[path] ?? []);
    if (found.length > 0)
      throw new Error(`PACKAGED_TEST_BUILD_MARKER: ${path} (${found.join(", ")})`);
  }
}

function nativeBuildEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...releaseRustEnv(root),
    CARGO_TARGET_DIR: "target",
    ATM_REQUIRE_VERSION_RESOURCE: "1",
  };
}

/**
 * 只构建演练用 setup（drill feature，连同演练要的 examples）。cargo 是增量的：源码没变就什么都不做。
 * install-drill 每次都先调它——演练包里的 setup 必须是这份源码的，不能是上回留下的。
 */
export function buildDrillSetup(root: string): void {
  run(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "-p",
      "atm-setup",
      "--features",
      "drill",
      "--bins",
      "--examples",
    ],
    join(root, NATIVE_CRATE_DIR),
    { ...nativeBuildEnv(root), CARGO_TARGET_DIR: "target-drill" },
  );
}

function buildNative(root: string, drill: boolean, smoke: boolean): void {
  const cwd = join(root, NATIVE_CRATE_DIR);
  const env = nativeBuildEnv(root);
  run(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "-p",
      "atm-launcher",
      "-p",
      "atm-host",
      "-p",
      "atm-setup",
      "-p",
      "atm-cli",
    ],
    cwd,
    env,
  );
  if (drill) buildDrillSetup(root);
  if (smoke)
    run("cargo", ["build", "--release", "--locked", "-p", "atm-host", "--features", "smoke"], cwd, {
      ...env,
      CARGO_TARGET_DIR: "target-smoke",
    });
}

export function buildAll(root: string, drill = false, smoke = false): void {
  run(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--config", "apps/desktop/vite.config.ts"],
    root,
  );
  buildMcpShim(root);
  buildNative(root, drill, smoke);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`PACKAGE_LINK_IN_PAYLOAD: ${path}`);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 编译进二进制的迁移集合的指纹：3.0 自己的库（`v3/`）与 2.x 转换器认得的那一套（`legacy/<scope>/`），
 * 前缀/文件名 + 内容哈希，按路径排序。
 */
export function schemaSet(root: string): string {
  const sets = [
    { prefix: "v3", dir: join(root, NATIVE_CRATE_DIR, "store", "migrations") },
    { prefix: "legacy", dir: join(root, "migrations") },
  ];
  const lines = sets
    .flatMap(({ prefix, dir }) =>
      walk(dir).map(
        (path) =>
          `${prefix}/${relative(dir, path).split(sep).join("/")} ${sha256(readFileSync(path))}`,
      ),
    )
    .sort();
  return sha256(Buffer.from(lines.join("\n"), "utf8"));
}

function assertExecutable(appDir: string, path: string, internalName: string, label: string): void {
  assertExecutableIdentity(readFileSync(join(appDir, path)), internalName, label);
}

/** 版本目录里的每个原生可执行文件都必须带本版本的版本资源。 */
function assertExecutables(appDir: string, version: string): void {
  assertExecutableVersionResource(
    readFileSync(join(appDir, APP_LAYOUT.host)),
    version,
    "AyanamiTaskManager",
    "HOST",
  );
  assertExecutableVersionResource(
    readFileSync(join(appDir, APP_LAYOUT.launcher)),
    version,
    "AyanamiTaskManager",
    "LAUNCHER",
  );
  assertExecutableVersionResource(
    readFileSync(join(appDir, APP_LAYOUT.setup)),
    version,
    "AyanamiTaskManager 安装与修复",
    "SETUP",
  );
  assertExecutableVersionResource(
    readFileSync(join(appDir, APP_LAYOUT.cli)),
    version,
    "AyanamiTaskManager command line",
    "CLI",
  );
  assertMcpShimVersionResource(readFileSync(join(appDir, "resources", "atm-mcp.exe")), version);
}

export function packageNative(input: {
  root: string;
  outDir?: string;
  build?: boolean;
  /** 演练包：setup 换成 drill 构建，产物只能落在 output/ 下。 */
  drill?: boolean;
  /** 演练的第二版本：版本目录按这个版本号命名，原生 exe 沿用（版本身份取自目录名，版本资源不参与判定）。 */
  drillVersion?: string;
  /** 烟测包：宿主换成 smoke 构建，产物只能落在 output/ 下。 */
  smoke?: boolean;
}): NativeRelease {
  const root = resolve(input.root);
  const { version: sourceVersion } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as {
    version: string;
  };
  if (input.drillVersion !== undefined && input.drill !== true)
    throw new Error("DRILL_VERSION_REQUIRES_DRILL");
  const version = input.drillVersion ?? sourceVersion;
  const drill = input.drill === true;
  const smoke = input.smoke === true;
  if (input.build !== false) buildAll(root, drill, smoke);
  const out = resolve(input.outDir ?? join(root, "output", "package"));
  if (!out.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`))
    throw new Error(`PACKAGE_OUTSIDE_WORKSPACE: ${out}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  if (
    (drill || smoke) &&
    !out.toLowerCase().startsWith(`${join(root, "output").toLowerCase()}${sep}`)
  )
    throw new Error(`TEST_PACKAGE_OUTSIDE_OUTPUT: ${out}`);
  const exes = {
    ...nativeRelease(root),
    ...(drill ? { setup: drillSetup(root) } : {}),
    ...(smoke ? { host: smokeHost(root) } : {}),
  };
  for (const exe of [exes.host, exes.cli, exes.launcher, exes.setup])
    if (!existsSync(exe)) throw new Error(`NATIVE_ARTIFACT_MISSING: ${exe}`);

  const appDir = assembleAppDirectory({
    root,
    target: join(out, `app-${version}`),
    hostExe: exes.host,
    cliExe: exes.cli,
    mcpShimExe: join(root, MCP_SHIM_RELEASE_EXE),
    rendererDir: join(root, "apps", "desktop", "dist", "renderer"),
    stampedGuide: stampAgentGuide(readFileSync(join(root, "ATM_AGENT_GUIDE.md"), "utf8"), {
      ...resolveAgentGuideBuild(root),
      version,
    }),
    launcherExe: exes.launcher,
    setupExe: exes.setup,
  });
  writeFileSync(join(appDir, THIRD_PARTY_NOTICES), buildThirdPartyNotices(root), "utf8");
  // 烟测包总是就地便携运行：没有安装根、没有 app.json，宿主靠这个标记认出便携布局。
  if (smoke) writeFileSync(join(appDir, PORTABLE_MARKER), "");
  // 身份与版本无关，演练包也查：同名的宿主被当成启动器拷进包，启动「也能用」，却没了安装屏障。
  assertExecutable(appDir, APP_LAYOUT.host, "AyanamiTaskManager.Host", "HOST");
  assertExecutable(appDir, APP_LAYOUT.launcher, "AyanamiTaskManager.Launcher", "LAUNCHER");
  assertExecutable(appDir, APP_LAYOUT.setup, "atm-setup", "SETUP");
  assertExecutable(appDir, APP_LAYOUT.cli, "atm", "CLI");
  if (input.drillVersion === undefined) assertExecutables(appDir, version);
  if (smoke) assertSmokeHost(readFileSync(join(appDir, APP_LAYOUT.host)));

  const payload = walk(appDir).map((path) => relative(appDir, path).split(sep).join("/"));
  assertNoTestBuildMarkers(appDir, payload, {
    ...(smoke ? { [APP_LAYOUT.host]: ["smoke"] } : {}),
    ...(drill ? { [APP_LAYOUT.setup]: ["drill"] } : {}),
  });
  const forbidden = findForbiddenPackagedEntries(payload);
  if (forbidden.length > 0) throw new Error(`PACKAGED_CONTENT_FORBIDDEN: ${forbidden.join(", ")}`);
  const missing = missingRequiredPackagedEntries(payload);
  if (missing.length > 0) throw new Error(`PACKAGED_CONTENT_MISSING: ${missing.join(", ")}`);
  const logos = payload.filter((path) => /^renderer\/assets\/logo[^/]*\.png$/u.test(path));
  if (logos.length === 0) throw new Error("PACKAGED_BRAND_ASSET_MISSING");
  for (const logo of logos) assertPublishedLogoBytes(readFileSync(join(appDir, logo)), logo);
  // 构建机路径（用户目录、cargo 主目录、仓库根，以及外面设过的 cargo target 目录）不能出现在
  // 任何发出去的字节里。
  const needles = buildMachinePathNeedles([
    homedir(),
    cargoHome(),
    root,
    ...(process.env.CARGO_TARGET_DIR ? [resolve(root, process.env.CARGO_TARGET_DIR)] : []),
  ]);
  for (const path of payload) {
    const found = findBuildMachinePath(readFileSync(join(appDir, path)), needles);
    if (found !== null) throw new Error(`PACKAGED_CONTENT_MAINTAINER_PATH: ${path} (${found})`);
  }

  const files: ManifestFile[] = [];
  const zippable: Zippable = {};
  for (const path of walk(appDir).sort()) {
    const name = relative(appDir, path).split(sep).join("/");
    const bytes = readFileSync(path);
    files.push({ path: name, size: bytes.length, sha256: sha256(bytes) });
    zippable[name] = [bytes, { mtime: FIXED_MTIME, level: 9 }];
  }
  const packageName = `atm-${version}-win-x64.zip`;
  const zipBytes = zipSync(zippable);
  const zipPath = join(out, packageName);
  writeFileSync(zipPath, zipBytes);
  const setupPath = join(out, "atm-setup.exe");
  copyFileSync(exes.setup, setupPath);
  const manifest: NativeManifest = {
    format: MANIFEST_FORMAT,
    version,
    arch: "x64",
    package: packageName,
    packageSha256: sha256(zipBytes),
    packageBytes: zipBytes.length,
    unpackedBytes: files.reduce((total, file) => total + file.size, 0),
    minWebView2: MIN_WEBVIEW2,
    schemaSet: schemaSet(root),
    files,
  };
  // 清单最后写：它出现了，zip 才算完整发布（§6 投递顺序）。
  const manifestPath = join(out, `atm-${version}-win-x64.json`);
  writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  rmSync(manifestPath, { force: true });
  copyFileSync(`${manifestPath}.tmp`, manifestPath);
  rmSync(`${manifestPath}.tmp`);
  return { version, dir: out, appDir, zip: zipPath, manifest: manifestPath, setup: setupPath };
}

/** 便携 zip 的文件名；解压出来是一个带 portable 标记的版本目录。 */
export function portableZipName(version: string): string {
  return `AyanamiTaskManager-${version}-win-x64-portable.zip`;
}

/**
 * 便携版：同一个版本目录加上 portable 标记，放在 `AyanamiTaskManager-<v>\` 下打成 zip。
 * 内容逐字节就是安装包里的那些文件，只多一个标记——便携与安装验的是同一份二进制。
 * 标记里写版本号：安装版的版本是 `app-<v>` 目录名，便携目录用户爱怎么改名就怎么改，
 * 宿主从标记读（install-state `product_version`），否则自报 dev。
 */
export function packagePortable(release: NativeRelease): string {
  const folder = `AyanamiTaskManager-${release.version}`;
  const zippable: Zippable = {};
  for (const path of walk(release.appDir).sort()) {
    const name = relative(release.appDir, path).split(sep).join("/");
    zippable[`${folder}/${name}`] = [readFileSync(path), { mtime: FIXED_MTIME, level: 9 }];
  }
  zippable[`${folder}/${PORTABLE_MARKER}`] = [
    new TextEncoder().encode(release.version),
    { mtime: FIXED_MTIME },
  ];
  const zipPath = join(release.dir, portableZipName(release.version));
  writeFileSync(zipPath, zipSync(zippable));
  return zipPath;
}

/**
 * 发布流水线的打包阶段：一次构建，生产包、便携 zip、烟测包；最后记下两套 exe 的哈希
 * （候选绑定 L6，candidate-binaries.ts），之后的验收报告逐份对它。
 */
export function packageRelease(root: string): { release: NativeRelease; portable: string } {
  buildAll(root, false, true);
  const release = packageNative({ root, build: false, outDir: join(root, "output", "package") });
  const portable = packagePortable(release);
  const smoke = packageNative({
    root,
    build: false,
    smoke: true,
    outDir: join(root, "output", "package-smoke"),
  });
  writeCandidateBinaries(root, {
    version: release.version,
    releaseAppDir: release.appDir,
    smokeAppDir: smoke.appDir,
  });
  return { release, portable };
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

if (
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href &&
  process.argv.includes("--release")
) {
  const { release, portable } = packageRelease(process.cwd());
  process.stdout.write(`${release.version}: ${release.manifest}\n${portable}\n`);
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const release = packageNative({
    root: process.cwd(),
    build: !process.argv.includes("--no-build"),
    ...(process.argv.includes("--drill")
      ? { drill: true, outDir: process.argv[process.argv.indexOf("--drill") + 1] }
      : {}),
    ...(process.argv.includes("--drill-version")
      ? { drillVersion: process.argv[process.argv.indexOf("--drill-version") + 1] }
      : {}),
    ...(process.argv.includes("--smoke")
      ? { smoke: true, outDir: process.argv[process.argv.indexOf("--smoke") + 1] }
      : {}),
  });
  const manifest = JSON.parse(readFileSync(release.manifest, "utf8")) as NativeManifest;
  process.stdout.write(
    `${release.version}: app ${mib(manifest.unpackedBytes)} in ${manifest.files.length} files, ` +
      `zip ${mib(statSync(release.zip).size)} → ${release.dir}\n`,
  );
}
