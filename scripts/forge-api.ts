import { api } from "@electron-forge/core";
import { extractFile, listPackage } from "@electron/asar";
import type { Dirent } from "node:fs";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readAgentGuideBuild,
  stampAgentGuide,
  type AgentGuideBuild,
} from "../apps/desktop/src/agent-guide-stamp.js";
import { buildMcpShim } from "./mcp-shim-build.js";
import {
  assertMcpShimVersionResource,
  assertPublishedLogoBytes,
  findForbiddenPackagedEntries,
  missingRequiredPackagedEntries,
} from "./package-content-policy.js";

const forbiddenAsarContent = [
  Buffer.from("C:\\Users\\ayanami", "utf8"),
  Buffer.from("C:/Users/ayanami", "utf8"),
  Buffer.from("R:\\Project_All", "utf8"),
  Buffer.from("R:/Project_All", "utf8"),
] as const;

async function containsAnyBytes(path: string, needles: readonly Buffer[]): Promise<boolean> {
  return new Promise((resolveContains, rejectContains) => {
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    let carry = Buffer.alloc(0);
    let settled = false;
    stream.on("data", (chunk: string | Buffer) => {
      if (settled) return;
      const data = Buffer.concat([carry, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (needles.some((needle) => data.includes(needle))) {
        settled = true;
        stream.destroy();
        resolveContains(true);
        return;
      }
      carry = data.subarray(Math.max(0, data.length - 128));
    });
    stream.once("end", () => {
      if (!settled) resolveContains(false);
    });
    stream.once("close", () => {
      if (!settled) resolveContains(false);
    });
    stream.once("error", (error) => {
      if (!settled) rejectContains(error);
    });
  });
}

export async function assertPackagedApplicationContents(dir: string): Promise<void> {
  const out = join(dir, "out");
  const packages = await readdir(out, { withFileTypes: true });
  const candidates = packages.filter(
    (entry) => entry.isDirectory() && entry.name.startsWith("AyanamiTaskManager-"),
  );
  if (candidates.length === 0) throw new Error("PACKAGED_APPLICATION_NOT_FOUND");
  const { version } = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
    version: string;
  };
  for (const candidate of candidates) {
    const resourcesPath = join(out, candidate.name, "resources");
    const asarPath = join(resourcesPath, "app.asar");
    if (existsSync(join(resourcesPath, "logo.png"))) {
      throw new Error("PACKAGED_CONTENT_LOOSE_BRAND_ASSET");
    }
    const guideBuild = readAgentGuideBuild(
      await readFile(join(resourcesPath, "ATM_AGENT_GUIDE.md"), "utf8"),
    );
    if (guideBuild?.version !== version) {
      throw new Error(`PACKAGED_AGENT_GUIDE_STAMP_INVALID: ${JSON.stringify(guideBuild)}`);
    }
    const shim = join(resourcesPath, "atm-mcp.exe");
    if (!existsSync(shim)) throw new Error("PACKAGED_MCP_SHIM_MISSING");
    assertMcpShimVersionResource(await readFile(shim), version);
    const entries = listPackage(asarPath, { isPack: false });
    const forbidden = findForbiddenPackagedEntries(entries);
    if (forbidden.length > 0) {
      throw new Error(`PACKAGED_CONTENT_FORBIDDEN: ${forbidden.slice(0, 20).join(", ")}`);
    }
    const missing = missingRequiredPackagedEntries(entries);
    if (missing.length > 0) {
      throw new Error(`PACKAGED_CONTENT_MISSING: ${missing.join(", ")}`);
    }
    const packagedLogos = entries
      .map((entry) => entry.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, ""))
      .filter(
        (normalized) =>
          normalized === "logo.png" ||
          /^apps\/desktop\/dist\/renderer\/assets\/logo-[^/]+\.png$/u.test(normalized),
      );
    if (packagedLogos.length < 2) throw new Error("PACKAGED_BRAND_ASSET_MISSING");
    for (const logo of packagedLogos) {
      const archiveEntry = process.platform === "win32" ? logo.replaceAll("/", "\\") : logo;
      assertPublishedLogoBytes(extractFile(asarPath, archiveEntry), logo);
    }
    if (await containsAnyBytes(asarPath, forbiddenAsarContent)) {
      throw new Error("PACKAGED_CONTENT_MAINTAINER_PATH");
    }
  }
}

async function removeEmptyDescendants(directory: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(directory, entry.name);
    if (await removeEmptyDescendants(child)) await rmdir(child);
  }
  return (await readdir(directory)).length === 0;
}

export async function prunePackagedAgentResourcePlaceholders(dir: string): Promise<void> {
  const out = join(dir, "out");
  let packages: Dirent[];
  try {
    packages = await readdir(out, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of packages) {
    if (!entry.isDirectory() || !entry.name.startsWith("AyanamiTaskManager-")) continue;
    const resources = join(out, entry.name, "resources");
    await removeEmptyDescendants(join(resources, "docs"));
    await removeEmptyDescendants(join(resources, "integrations"));
  }
}

/**
 * 打包用的构建身份：package.json 的版本 + HEAD 的 12 位短哈希。工作区有未提交的已跟踪改动时
 * 加 `-dirty`，本机调试包因此一眼能和正式构建区分开。取不到 commit 就让打包失败，
 * 不盖一个说不清来历的戳。
 */
export function resolveAgentGuideBuild(
  dir: string,
  git: (args: string[]) => string = (args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }),
): AgentGuideBuild {
  const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    version: string;
  };
  const head = git(["rev-parse", "--short=12", "HEAD"]).trim();
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).trim() !== "";
  return { version, commit: dirty ? `${head}-dirty` : head };
}

export async function stampPackagedAgentGuides(dir: string, build: AgentGuideBuild): Promise<void> {
  const out = join(dir, "out");
  for (const entry of await readdir(out, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("AyanamiTaskManager-")) continue;
    const guide = join(out, entry.name, "resources", "ATM_AGENT_GUIDE.md");
    await writeFile(guide, stampAgentGuide(await readFile(guide, "utf8"), build), "utf8");
  }
}

export async function packageApplication(dir: string): Promise<void> {
  buildMcpShim(dir);
  await api.package({ dir, interactive: false });
  await prunePackagedAgentResourcePlaceholders(dir);
  await stampPackagedAgentGuides(dir, resolveAgentGuideBuild(dir));
  await assertPackagedApplicationContents(dir);
}

export async function makeApplication(dir: string) {
  return api.make({ dir, interactive: false, skipPackage: true });
}
