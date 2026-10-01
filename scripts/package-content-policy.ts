const normalized = (entry: string): string =>
  entry.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");

/**
 * 版本目录（app-<v>，de-electron §3）里必须有的文件：缺任何一个，装上去要么起不来，要么少了
 * 一块要交付的东西。路径相对版本目录、用 `/`，和清单 files[].path 同一写法。
 */
export const REQUIRED_PACKAGED_ENTRIES = [
  "AyanamiTaskManager.exe",
  "launcher/AyanamiTaskManager.exe",
  "atm-setup.exe",
  "LICENSE",
  "THIRD_PARTY_NOTICES.txt",
  "runtime/atm-core.exe",
  "runtime/core.mjs",
  "runtime/cli.mjs",
  "runtime/node_modules/better-sqlite3/package.json",
  "runtime/node_modules/better-sqlite3/prebuilds/win32-x64.node",
  "renderer/index.html",
  "resources/ATM_AGENT_GUIDE.md",
  "resources/mcp-stdio.cjs",
  "resources/atm-mcp.exe",
  "migrations/registry/0001_initial.sql",
  "migrations/project/0001_initial.sql",
  "migrations/knowledge/0001_initial.sql",
  "migrations/registry/0008_global_event_class_indexes.sql",
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
  assertExecutableVersionResource(
    bytes,
    version,
    "AyanamiTaskManager MCP stdio bridge",
    "MCP_SHIM",
  );
}

/** 同一条规则，用于宿主、根启动器和 atm-setup（native/build-support 写的资源）。 */
export function assertExecutableVersionResource(
  bytes: Buffer,
  version: string,
  description: string,
  label: string,
): void {
  const nul = String.fromCharCode(0);
  const key = Buffer.from(`ProductVersion${nul}`, "utf16le");
  const expected = Buffer.from(`${version}${nul}`, "utf16le");
  // 大二进制里 "ProductVersion" 也会出现在依赖库的常量里；只认版本资源结构之后的那一处。
  const resource = bytes.lastIndexOf(Buffer.from("VS_VERSION_INFO", "utf16le"));
  const at = resource < 0 ? -1 : bytes.indexOf(key, resource);
  if (at < 0 || !bytes.includes(Buffer.from(description, "utf16le")))
    throw new Error(`PACKAGED_${label}_VERSION_RESOURCE_MISSING`);
  let value = at + key.length;
  // 补齐是相对资源结构对齐的，不是相对文件偏移；值的首字符不会是 NUL，见零就跳。
  if (value + 2 <= bytes.length && bytes.readUInt16LE(value) === 0) value += 2;
  if (!bytes.subarray(value, value + expected.length).equals(expected)) {
    let end = value;
    while (end + 2 <= bytes.length && end < value + 64 && bytes.readUInt16LE(end) !== 0) end += 2;
    const found = bytes.subarray(value, end).toString("utf16le");
    throw new Error(`PACKAGED_${label}_VERSION_MISMATCH: expected ${version}, found ${found}`);
  }
}

/**
 * 版本资源里 InternalName 的值；没有版本资源或没有这个键时为 null。
 *
 * 宿主和根启动器的文件名、描述都是 AyanamiTaskManager（快捷方式和任务管理器里看到的就是它），
 * 只有 InternalName 能区分两者：把宿主当启动器拷进包，功能上「也能启动」，却没有了安装屏障。
 */
export function executableInternalName(bytes: Buffer): string | null {
  const nul = String.fromCharCode(0);
  const resource = bytes.lastIndexOf(Buffer.from("VS_VERSION_INFO", "utf16le"));
  const key = Buffer.from(`InternalName${nul}`, "utf16le");
  const at = resource < 0 ? -1 : bytes.indexOf(key, resource);
  if (at < 0) return null;
  let value = at + key.length;
  if (value + 2 <= bytes.length && bytes.readUInt16LE(value) === 0) value += 2;
  let end = value;
  while (end + 2 <= bytes.length && end < value + 128 && bytes.readUInt16LE(end) !== 0) end += 2;
  return bytes.subarray(value, end).toString("utf16le");
}

export function assertExecutableIdentity(bytes: Buffer, internalName: string, label: string): void {
  const found = executableInternalName(bytes);
  if (found !== internalName)
    throw new Error(`PACKAGED_${label}_WRONG_EXECUTABLE: expected ${internalName}, found ${found}`);
}

/**
 * 构建机路径在二进制里可能的几种写法：正斜杠、JSON/JS 字符串里反斜杠翻倍或写成 \u005c、
 * 整条路径逐字符写成 \uXXXX；UTF-8 与 UTF-16LE（PE 资源和宽字符串）各一份。
 *
 * Windows 路径不分大小写，工具链也会改写大小写：针里的 ASCII 字母一律小写，比对时把内容里的
 * ASCII 字母也折成小写（见 findBuildMachinePath）。非 ASCII 字符不折，针同时备一份原样、一份
 * 整体小写。
 */
export type BuildMachinePathNeedle = {
  spelling: string;
  encoding: "utf8" | "utf16le";
  bytes: Buffer;
};

const asciiLower = (text: string) => text.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
const unicodeEscaped = (text: string) =>
  [...text]
    .map((character) =>
      [...Buffer.from(character, "utf16le").swap16().toString("hex").match(/.{4}/gu)!]
        .map((unit) => `\\u${unit}`)
        .join(""),
    )
    .join("");

export function buildMachinePathNeedles(paths: readonly string[]): BuildMachinePathNeedle[] {
  const spellings = new Set<string>();
  for (const path of paths) {
    const trimmed = path.replace(/[\\/]+$/u, "");
    if (trimmed.length < 4) continue;
    for (const variant of new Set([asciiLower(trimmed), asciiLower(trimmed.toLowerCase())])) {
      spellings.add(variant);
      spellings.add(variant.replaceAll("\\", "/"));
      spellings.add(variant.replaceAll("\\", "\\\\"));
      spellings.add(variant.replaceAll("\\", "\\u005c"));
    }
    // 逐字符转义保留原字符的大小写（转义码里看得出来），原样与整体小写各一份。
    spellings.add(unicodeEscaped(trimmed));
    spellings.add(unicodeEscaped(trimmed.toLowerCase()));
  }
  return [...spellings].flatMap((spelling): BuildMachinePathNeedle[] => [
    { spelling, encoding: "utf8", bytes: Buffer.from(spelling, "utf8") },
    { spelling, encoding: "utf16le", bytes: Buffer.from(spelling, "utf16le") },
  ]);
}

/**
 * UTF-8 的多字节序列每个字节都 ≥ 0x80，逐字节折 ASCII 不会碰到它们。UTF-16LE 不行：汉字等
 * 字符的任一字节都可能落在 0x41..0x5A，只能按「高字节为 0 的代码单元」折，而且宽字符串可能从
 * 奇数偏移开始，两种对齐各折一份。
 */
function foldUtf8(bytes: Buffer): Buffer {
  const folded = Buffer.from(bytes);
  for (let index = 0; index < folded.length; index += 1) {
    const byte = folded[index]!;
    if (byte >= 0x41 && byte <= 0x5a) folded[index] = byte + 0x20;
  }
  return folded;
}

function foldUtf16(bytes: Buffer, offset: 0 | 1): Buffer {
  const folded = Buffer.from(bytes);
  for (let index = offset; index + 1 < folded.length; index += 2) {
    const low = folded[index]!;
    if (folded[index + 1] === 0 && low >= 0x41 && low <= 0x5a) folded[index] = low + 0x20;
  }
  return folded;
}

export function findBuildMachinePath(
  bytes: Buffer,
  needles: readonly BuildMachinePathNeedle[],
): string | null {
  const utf8 = foldUtf8(bytes);
  for (const needle of needles)
    if (needle.encoding === "utf8" && utf8.includes(needle.bytes)) return needle.spelling;
  for (const offset of [0, 1] as const) {
    const utf16 = foldUtf16(bytes, offset);
    for (const needle of needles)
      if (needle.encoding === "utf16le" && utf16.includes(needle.bytes)) return needle.spelling;
  }
  return null;
}

const forbiddenEntryPatterns = [
  // 用户数据：知识库、数据库文件，任何时候都不进包。
  /^knowledge(?:\/|$)/u,
  /(?:^|\/)[^/]+\.sqlite(?:-(?:wal|shm))?$/u,
  // 仓库与工具目录、源码、source map、原生构建的调试与链接中间件。
  /(?:^|\/)\.(?:claude|crossagent|github|git)(?:\/|$)/u,
  /^(?:apps|packages|scripts|src)(?:\/|$)/u,
  /\.(?:ts|tsx|map|pdb|ilk|exp|lib)$/u,
  // runtime 只带 better-sqlite3 的运行时部分：没有它的 C 源码、构建目录，也没有别的包。
  /^runtime\/node_modules\/(?!better-sqlite3(?:$|\/))/u,
  /^runtime\/node_modules\/better-sqlite3\/(?:src|deps|build)(?:\/|$)/u,
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
