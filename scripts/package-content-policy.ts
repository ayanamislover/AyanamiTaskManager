const normalized = (entry: string): string =>
  entry.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");

export const REQUIRED_PACKAGED_ENTRIES = [
  "package.json",
  "LICENSE",
  "logo.png",
  "apps/desktop/dist/main/main.cjs",
  "apps/desktop/dist/main/preload.cjs",
  "apps/desktop/dist/renderer/index.html",
  "migrations/registry/0001_initial.sql",
  "migrations/project/0001_initial.sql",
] as const;

export const PUBLISHED_LOGO_MAX_EDGE = 256;
export const PUBLISHED_LOGO_MAX_BYTES = 256 * 1024;

export function assertPublishedLogoBytes(bytes: Buffer, entry: string): void {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(pngSignature)) {
    throw new Error(`PACKAGED_BRAND_ASSET_NOT_PNG: ${entry}`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (
    width > PUBLISHED_LOGO_MAX_EDGE ||
    height > PUBLISHED_LOGO_MAX_EDGE ||
    bytes.length > PUBLISHED_LOGO_MAX_BYTES
  ) {
    throw new Error(`PACKAGED_BRAND_ASSET_TOO_LARGE: ${entry} ${width}x${height} ${bytes.length}`);
  }
}

const forbiddenEntryPatterns = [
  /^(?:\.claude|\.crossagent|\.github)(?:\/|$)/u,
  /^(?:packages|scripts|integrations)(?:\/|$)/u,
  /^apps\/(?!desktop(?:$|\/dist(?:\/|$)))/u,
  /^node_modules\/(?:\.cache(?:\/|$)|\.modules\.yaml$|\.package-map\.json$)/u,
  /^ATM_AGENT_GUIDE\.md$/u,
  /^(?:README\.md|forge\.config\.ts|playwright\.config\.ts|vitest\.config\.ts|tsconfig(?:\.base)?\.json)$/u,
  /^node_modules\/(?:\.pnpm\/better-sqlite3@[^/]+\/node_modules\/)?better-sqlite3\/build\/(?!Release(?:$|\/better_sqlite3\.node$))/u,
] as const;

export function findForbiddenPackagedEntries(entries: Iterable<string>): string[] {
  return [
    ...new Set(
      [...entries]
        .map(normalized)
        .filter((entry) => forbiddenEntryPatterns.some((pattern) => pattern.test(entry))),
    ),
  ].sort();
}

export function missingRequiredPackagedEntries(entries: Iterable<string>): string[] {
  const normalizedEntries = new Set([...entries].map(normalized));
  return REQUIRED_PACKAGED_ENTRIES.filter((entry) => !normalizedEntries.has(entry));
}
