import { pathToFileURL } from "node:url";

export const DEVELOPMENT_RENDERER_ORIGIN = "http://127.0.0.1:9999";

export function rendererEntryUrl(input: {
  packaged: boolean;
  rendererUrl?: string;
  rendererFile: string;
}): string {
  const packagedEntry = pathToFileURL(input.rendererFile).href;
  if (input.packaged || !input.rendererUrl) return packagedEntry;
  const candidate = new URL(input.rendererUrl);
  if (
    candidate.origin !== DEVELOPMENT_RENDERER_ORIGIN ||
    candidate.pathname !== "/" ||
    candidate.search ||
    candidate.hash ||
    candidate.username ||
    candidate.password
  )
    throw new Error("ATM_RENDERER_URL_INVALID");
  return candidate.href;
}

export function rendererNavigationAllowed(entry: string, target: string): boolean {
  const expected = new URL(entry);
  const candidate = new URL(target);
  if (expected.protocol === "file:")
    return candidate.protocol === "file:" && candidate.pathname === expected.pathname;
  return candidate.origin === expected.origin;
}
