const normalized = (entry: string): string =>
  entry.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");

export const REQUIRED_PACKAGED_ENTRIES = [
  "package.json",
  "LICENSE",
  "apps/desktop/dist/main/main.cjs",
  "apps/desktop/dist/main/preload.cjs",
  "apps/desktop/dist/renderer/index.html",
  "migrations/registry/0001_initial.sql",
  "migrations/project/0001_initial.sql",
] as const;

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
