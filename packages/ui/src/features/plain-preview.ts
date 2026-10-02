/**
 * 派单结果的纯文本预览。
 *
 * 派单列表里 Claude 的结果原文多是 Markdown，只给两行，按纯文本显示。先认出代码，代码内容原样保留、
 * 只去掉分隔符；只对正文去掉行首的标题 / 引用 / 列表记号、成对的双星号和链接语法。所以代码里的
 * glob 双星号、链接写法、`>=` 都不会被当成记号改写；单个星号与下划线一律不动（标识符里常有下划线，
 * 误删比留着更糟）。清理完什么都不剩时退回原文：宁可露出记号，也不能让一条失败原因变成空行。
 * 存下来的原文不改。
 *
 * 代码的认法（CommonMark 的保守子集）：
 * - 围栏：缩进不超过 3 列的三个以上反引号或波浪号；反引号围栏的信息串里不能再有反引号（否则是行内代码）；
 *   同字符、不短于开头的围栏行才闭合，没闭合就到结尾。缩进按列算，Tab 跳到下一个 4 的倍数。
 * - 缩进代码：围栏外缩进 4 列及以上的行一律按原文（宁可少清理嵌套列表的记号）。
 * - 行内代码：n 个反引号到同一行里下一段恰好 n 个反引号；配不上的反引号按原文留在正文里。
 *
 * 正文清理时，每段行内代码先换成一个占位字符，整行一起清理（链接文字里夹着代码也认得出），
 * 再换回代码原文；代码内容因此碰不到任何正则。
 * 只看前 {@link PREVIEW_INPUT_LIMIT} 个 UTF-16 码元：列表里只有两行，再长也看不见，这样任何输入的
 * 开销都有上限（派单历史是本机文件，读回时不限长度）。
 */
export function plainPreview(text: string): string {
  const bounded = boundedInput(text);
  const out: string[] = [];
  let fence: Fence | null = null;
  for (const line of bounded.split(/\r?\n/u)) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      else out.push(line);
      continue;
    }
    if (indentColumns(line) >= CODE_INDENT) {
      out.push(line);
      continue;
    }
    fence = opensFence(line);
    if (!fence) out.push(proseLine(line));
  }
  const preview = collapse(out.join("\n"));
  return preview || collapse(bounded);
}

export const PREVIEW_INPUT_LIMIT = 2000;

/** 截到上限；多取一个码元再按码点丢掉最后一个，免得把代理对劈成半个。 */
function boundedInput(text: string): string {
  if (text.length <= PREVIEW_INPUT_LIMIT) return text;
  return Array.from(text.slice(0, PREVIEW_INPUT_LIMIT + 1))
    .slice(0, -1)
    .join("");
}

type Fence = { char: string; length: number };

const CODE_INDENT = 4;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*)$/u;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/u;
/** 行首记号：后面必须跟空白（标题、引用也可以直接到行尾），`#123`、`>=22` 这类普通文本不算。 */
const LINE_MARKER =
  /^[ \t]*(?:#{1,6}(?=[ \t]|$)|>(?=[ \t]|$)|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]*/u;
const LINK = /\[([^\]\n]+)\]\(([^)\s]*)\)/gu;
/** 行内代码的占位字符取 Unicode 私用区，运行时生成。 */
const PLACEHOLDER_BASE = 0xe000;
const PLACEHOLDER_END = 0xf8ff;

function collapse(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** 行首缩进的列数：空格算 1 列，Tab 跳到下一个 4 的倍数。 */
function indentColumns(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += CODE_INDENT - (columns % CODE_INDENT);
    else break;
  }
  return columns;
}

function opensFence(line: string): Fence | null {
  if (indentColumns(line) >= CODE_INDENT) return null;
  const match = FENCE_OPEN.exec(line);
  if (!match?.[1]) return null;
  const marker = match[1];
  if (marker.startsWith("`") && (match[2] ?? "").includes("`")) return null;
  return { char: marker.charAt(0), length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  if (indentColumns(line) >= CODE_INDENT) return false;
  const marker = FENCE_CLOSE.exec(line)?.[1];
  return Boolean(marker && marker.charAt(0) === fence.char && marker.length >= fence.length);
}

function isPlaceholder(codePoint: number): boolean {
  return codePoint >= PLACEHOLDER_BASE && codePoint <= PLACEHOLDER_END;
}

function placeholderIndexes(text: string, count: number): number[] {
  return Array.from(text).flatMap((char) => {
    const index = (char.codePointAt(0) ?? 0) - PLACEHOLDER_BASE;
    return index >= 0 && index < count ? [index] : [];
  });
}

/**
 * 链接只留文字。目标里有行内代码（占位符）时那不是能省略的地址（例如 [检查](`ENOENT: …`)），
 * 整段留着，免得把代码连同地址一起删掉；文字里的代码照常保留。
 */
function cleanProse(text: string): string {
  return dropBold(text)
    .replace(LINE_MARKER, "")
    .replace(LINK, (whole: string, label: string, target: string) =>
      Array.from(target).some((char) => isPlaceholder(char.codePointAt(0) ?? 0)) ? whole : label,
    );
}

function proseLine(line: string): string {
  const spans = inlineCode(line);
  if (spans.length === 0) return cleanProse(line);
  // 这一行本来就有私用区字符时占位符会撞车：整行按原文。
  if (Array.from(line).some((char) => isPlaceholder(char.codePointAt(0) ?? 0))) return line;
  let masked = "";
  let cursor = 0;
  spans.forEach((span, index) => {
    masked += line.slice(cursor, span.start) + String.fromCharCode(PLACEHOLDER_BASE + index);
    cursor = span.end;
  });
  masked += line.slice(cursor);
  const cleaned = cleanProse(masked);
  // 兜底：清理不该删掉、复制或调换任何一段代码；对不上就整行按原文，宁可露出记号也不丢内容。
  const kept = placeholderIndexes(cleaned, spans.length);
  if (kept.length !== spans.length || kept.some((index, at) => index !== at)) return line;
  let result = "";
  for (const char of cleaned) {
    const index = (char.codePointAt(0) ?? 0) - PLACEHOLDER_BASE;
    const span = index >= 0 ? spans[index] : undefined;
    result += span ? span.code : char;
  }
  return result;
}

type CodeSpan = { start: number; end: number; code: string };

/** 一行里的行内代码：n 个反引号开头，到下一段恰好 n 个反引号结束；配不上的反引号留在正文里。 */
function inlineCode(line: string): CodeSpan[] {
  const runs: Array<{ at: number; length: number }> = [];
  const backticks = /`+/gu;
  for (let match = backticks.exec(line); match; match = backticks.exec(line))
    runs.push({ at: match.index, length: match[0].length });
  const spans: CodeSpan[] = [];
  for (let index = 0; index < runs.length; index += 1) {
    const open = runs[index]!;
    const closeAt = runs.findIndex((run, later) => later > index && run.length === open.length);
    if (closeAt === -1) continue;
    const close = runs[closeAt]!;
    spans.push({
      start: open.at,
      end: close.at + close.length,
      code: line.slice(open.at + open.length, close.at),
    });
    index = closeAt;
  }
  return spans;
}

/**
 * 去掉一行里成对的双星号：左边那个后面紧跟非空白、右边那个前面紧跟非空白才算一对
 * （简化的 CommonMark 规则），所以 `a ** b`、`2**10` 原样保留；占位的行内代码算非空白。
 */
function dropBold(text: string): string {
  const filled = (char: string | undefined) => char !== undefined && !/\s/u.test(char);
  const drop: number[] = [];
  let open: number | null = null;
  for (let at = text.indexOf("**"); at !== -1; at = text.indexOf("**", at + 2)) {
    if (open !== null && filled(text[at - 1])) {
      drop.push(open, at);
      open = null;
    } else if (filled(text[at + 2])) {
      open = at;
    }
  }
  let result = text;
  for (const at of drop.sort((a, b) => b - a)) result = result.slice(0, at) + result.slice(at + 2);
  return result;
}
