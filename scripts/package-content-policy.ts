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
  "migrations/knowledge/0001_initial.sql",
  "migrations/registry/0006_knowledge_backups.sql",
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

/**
 * 包里的 atm-mcp.exe 必须带版本资源，而且 ProductVersion 就是本次发布的版本。
 *
 * 缺版本资源说明 rc.exe 那一步没跑；版本对不上说明拷进包的是一份旧构建。两种都能正常
 * 转发 MCP，功能测试发现不了，只能在这里拦。VS_VERSIONINFO 的 String 结构是
 * UTF-16LE 的键、NUL、补齐到 4 字节边界的 0～2 个字节，然后是 UTF-16LE 的值和 NUL。
 */
export function assertMcpShimVersionResource(bytes: Buffer, version: string): void {
  const nul = String.fromCharCode(0);
  const key = Buffer.from(`ProductVersion${nul}`, "utf16le");
  const expected = Buffer.from(`${version}${nul}`, "utf16le");
  const at = bytes.indexOf(key);
  if (at < 0 || !bytes.includes(Buffer.from("AyanamiTaskManager MCP stdio bridge", "utf16le")))
    throw new Error("PACKAGED_MCP_SHIM_VERSION_RESOURCE_MISSING");
  let value = at + key.length;
  // 补齐是相对资源结构对齐的，不是相对文件偏移；值的首字符不会是 NUL，见零就跳。
  if (value + 2 <= bytes.length && bytes.readUInt16LE(value) === 0) value += 2;
  if (!bytes.subarray(value, value + expected.length).equals(expected)) {
    let end = value;
    while (end + 2 <= bytes.length && end < value + 64 && bytes.readUInt16LE(end) !== 0) end += 2;
    const found = bytes.subarray(value, end).toString("utf16le");
    throw new Error(`PACKAGED_MCP_SHIM_VERSION_MISMATCH: expected ${version}, found ${found}`);
  }
}

const forbiddenEntryPatterns = [
  /^knowledge(?:\/|$)/u,
  /(?:^|\/)knowledge\.sqlite(?:-(?:wal|shm))?$/u,
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
