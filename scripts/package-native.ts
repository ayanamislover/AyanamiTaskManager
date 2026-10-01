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
  missingRequiredPackagedEntries,
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

export function nativeRelease(root: string): { host: string; launcher: string; setup: string } {
  const target = join(root, NATIVE_CRATE_DIR, "target", "release");
  return {
    host: join(target, "AyanamiTaskManager.exe"),
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

/** 只出现在 smoke 构建里的字面量；生产宿主里出现就是拿错了二进制。 */
const SMOKE_HOST_MARKER = "--remote-debugging-port";

export function assertProductionHost(bytes: Buffer): void {
  if (bytes.includes(Buffer.from(SMOKE_HOST_MARKER, "utf8")))
    throw new Error(`PACKAGED_HOST_IS_SMOKE_BUILD: ${SMOKE_HOST_MARKER}`);
}

export function assertSmokeHost(bytes: Buffer): void {
  if (!bytes.includes(Buffer.from(SMOKE_HOST_MARKER, "utf8")))
    throw new Error("SMOKE_HOST_WITHOUT_SMOKE_FEATURE");
}

function buildNative(root: string, drill: boolean, smoke: boolean): void {
  const cwd = join(root, NATIVE_CRATE_DIR);
  const env = {
    ...releaseRustEnv(root),
    CARGO_TARGET_DIR: "target",
    ATM_REQUIRE_VERSION_RESOURCE: "1",
  };
  run(
    "cargo",
    ["build", "--release", "--locked", "-p", "atm-launcher", "-p", "atm-host", "-p", "atm-setup"],
    cwd,
    env,
  );
  if (drill)
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
      cwd,
      {
        ...env,
        CARGO_TARGET_DIR: "target-drill",
      },
    );
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
  run(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "apps/desktop/scripts/build-core.ts"],
    root,
  );
  buildMcpShim(root);
  buildNative(root, drill, smoke);
}

/** 发布包里的 setup 不能带演练开关：扫二进制里的环境变量名。 */
export function assertProductionSetup(bytes: Buffer): void {
  for (const marker of [
    "ATM_SETUP_SANDBOX",
    "ATM_SETUP_DIE_AFTER",
    "ATM_SETUP_FAIL_AT",
    "ATM_SETUP_FAIL_UNDO",
    "ATM_SETUP_SQUIRREL_ADDS",
  ])
    if (bytes.includes(Buffer.from(marker, "utf8")))
      throw new Error(`PACKAGED_SETUP_IS_DRILL_BUILD: ${marker}`);
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

/** 随包迁移集合的指纹：scope/文件名 + 内容哈希，按路径排序。 */
export function schemaSet(migrationsRoot: string): string {
  const lines = walk(migrationsRoot)
    .map(
      (path) =>
        `${relative(migrationsRoot, path).split(sep).join("/")} ${sha256(readFileSync(path))}`,
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
  assertMcpShimVersionResource(readFileSync(join(appDir, "resources", "atm-mcp.exe")), version);
}

export function packageNative(input: {
  root: string;
  outDir?: string;
  build?: boolean;
  /** 演练包：setup 换成 drill 构建，产物只能落在 output/ 下。 */
  drill?: boolean;
  /** 演练的第二版本：core 以这个版本号另行构建，原生 exe 沿用（它们的版本资源不参与判定）。 */
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
  let coreDir: string | undefined;
  if (input.drillVersion !== undefined) {
    coreDir = join(out, "core-build");
    run(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "apps/desktop/scripts/build-core.ts"],
      root,
      {
        ATM_DRILL_VERSION: input.drillVersion,
        ATM_CORE_OUT_DIR: coreDir,
      },
    );
  }
  for (const exe of [exes.host, exes.launcher, exes.setup])
    if (!existsSync(exe)) throw new Error(`NATIVE_ARTIFACT_MISSING: ${exe}`);

  const appDir = assembleAppDirectory({
    root,
    target: join(out, `app-${version}`),
    hostExe: exes.host,
    nodeExe: process.execPath,
    mcpShimExe: join(root, MCP_SHIM_RELEASE_EXE),
    rendererDir: join(root, "apps", "desktop", "dist", "renderer"),
    stampedGuide: stampAgentGuide(readFileSync(join(root, "ATM_AGENT_GUIDE.md"), "utf8"), {
      ...resolveAgentGuideBuild(root),
      version,
    }),
    launcherExe: exes.launcher,
    setupExe: exes.setup,
    ...(coreDir ? { coreDir } : {}),
  });
  if (coreDir) rmSync(coreDir, { recursive: true, force: true });
  // 随包的 Node 就是跑这个脚本的 node（nodeExe: process.execPath），版本取 process.version。
  writeFileSync(join(appDir, THIRD_PARTY_NOTICES), buildThirdPartyNotices(root), "utf8");
  // 烟测包总是就地便携运行：没有安装根、没有 app.json，宿主靠这个标记认出便携布局。
  if (smoke) writeFileSync(join(appDir, PORTABLE_MARKER), "");
  // 身份与版本无关，演练包也查：同名的宿主被当成启动器拷进包，启动「也能用」，却没了安装屏障。
  assertExecutable(appDir, APP_LAYOUT.host, "AyanamiTaskManager.Host", "HOST");
  assertExecutable(appDir, APP_LAYOUT.launcher, "AyanamiTaskManager.Launcher", "LAUNCHER");
  assertExecutable(appDir, APP_LAYOUT.setup, "atm-setup", "SETUP");
  if (input.drillVersion === undefined) assertExecutables(appDir, version);
  if (!drill) assertProductionSetup(readFileSync(join(appDir, APP_LAYOUT.setup)));
  if (smoke) assertSmokeHost(readFileSync(join(appDir, APP_LAYOUT.host)));
  else assertProductionHost(readFileSync(join(appDir, APP_LAYOUT.host)));

  const payload = walk(appDir).map((path) => relative(appDir, path).split(sep).join("/"));
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
    schemaSet: schemaSet(join(root, "migrations")),
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
 * 内容逐字节就是安装包里的那些文件，只多一个空标记——便携与安装验的是同一份二进制。
 */
export function packagePortable(release: NativeRelease): string {
  const folder = `AyanamiTaskManager-${release.version}`;
  const zippable: Zippable = {};
  for (const path of walk(release.appDir).sort()) {
    const name = relative(release.appDir, path).split(sep).join("/");
    zippable[`${folder}/${name}`] = [readFileSync(path), { mtime: FIXED_MTIME, level: 9 }];
  }
  zippable[`${folder}/${PORTABLE_MARKER}`] = [new Uint8Array(), { mtime: FIXED_MTIME }];
  const zipPath = join(release.dir, portableZipName(release.version));
  writeFileSync(zipPath, zipSync(zippable));
  return zipPath;
}

/** 发布流水线的打包阶段：一次构建，生产包、便携 zip、烟测包。 */
export function packageRelease(root: string): { release: NativeRelease; portable: string } {
  buildAll(root, false, true);
  const release = packageNative({ root, build: false, outDir: join(root, "output", "package") });
  const portable = packagePortable(release);
  packageNative({
    root,
    build: false,
    smoke: true,
    outDir: join(root, "output", "package-smoke"),
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
