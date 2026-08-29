import { api } from "@electron-forge/core";
import { extractFile, listPackage } from "@electron/asar";
import type { Dirent } from "node:fs";
import { createReadStream, existsSync } from "node:fs";
import { readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
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
  for (const candidate of candidates) {
    const resourcesPath = join(out, candidate.name, "resources");
    const asarPath = join(resourcesPath, "app.asar");
    if (existsSync(join(resourcesPath, "logo.png"))) {
      throw new Error("PACKAGED_CONTENT_LOOSE_BRAND_ASSET");
    }
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

export async function packageApplication(dir: string): Promise<void> {
  await api.package({ dir, interactive: false });
  await prunePackagedAgentResourcePlaceholders(dir);
  await assertPackagedApplicationContents(dir);
}

export async function makeApplication(dir: string) {
  return api.make({ dir, interactive: false, skipPackage: true });
}
