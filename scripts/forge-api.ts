import { api } from "@electron-forge/core";
import type { Dirent } from "node:fs";
import { readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";

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
}

export async function makeApplication(dir: string) {
  return api.make({ dir, interactive: false, skipPackage: true });
}
