import { api } from "@electron-forge/core";

export async function packageApplication(dir: string): Promise<void> {
  return api.package({ dir, interactive: false });
}

export async function makeApplication(dir: string) {
  return api.make({ dir, interactive: false, skipPackage: true });
}
