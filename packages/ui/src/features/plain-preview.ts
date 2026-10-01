/**
 * 派单结果的纯文本预览。
 *
 * 派单列表里 Claude 的结果原文多是 Markdown，只给两行，按纯文本显示。先认出代码（围栏代码块、
 * 行内反引号），代码内容原样保留、只去掉分隔符；只对正文去掉行首的标题 / 引用 / 列表记号、成对的
 * 双星号和链接语法。所以代码里的 glob 双星号、链接写法、`>=` 都不会被当成记号改写；单个星号与
 * 下划线一律不动（标识符里常有下划线，误删比留着更糟）。清理完什么都不剩时退回原文：宁可露出记号，
 * 也不能让一条失败原因变成空行。存下来的原文不改。
 *
 * 简化之处：行内代码不跨行（配不上的反引号按原文留着），双星号只在同一行里配对。
 * 只看前 {@link PREVIEW_INPUT_LIMIT} 个字符：列表里只有两行，再长也看不见，这样任何输入的开销都有上限
 * （派单历史是本机文件，读回时不限长度）。
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
type Piece = { code: boolean; text: string };

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u;
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/u;
/** 行首记号：后面必须跟空白（标题、引用也可以直接到行尾），`#123`、`>=22` 这类普通文本不算。 */
const LINE_MARKER =
  /^[ \t]*(?:#{1,6}(?=[ \t]|$)|>(?=[ \t]|$)|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]*/u;
const LINK = /\[([^\]\n]+)\]\([^)\s]*\)/gu;

function collapse(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** CommonMark：反引号围栏的信息串里不能再有反引号，否则这一行是行内代码，不是围栏。 */
function opensFence(line: string): Fence | null {
  const match = FENCE_OPEN.exec(line);
  if (!match?.[1]) return null;
  const marker = match[1];
  if (marker.startsWith("`") && (match[2] ?? "").includes("`")) return null;
  return { char: marker.charAt(0), length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const marker = FENCE_CLOSE.exec(line)?.[1];
  return Boolean(marker && marker.charAt(0) === fence.char && marker.length >= fence.length);
}

function proseLine(line: string): string {
  const pieces = dropBold(splitInlineCode(line));
  return pieces
    .map((piece, index) => {
      if (piece.code) return piece.text;
      const text = index === 0 ? piece.text.replace(LINE_MARKER, "") : piece.text;
      return text.replace(LINK, "$1");
    })
    .join("");
}

/** 行内代码：n 个反引号开头，到下一段恰好 n 个反引号结束；配不上的反引号按原文留在正文里。 */
function splitInlineCode(line: string): Piece[] {
  const runs: Array<{ at: number; length: number }> = [];
  const backticks = /`+/gu;
  for (let match = backticks.exec(line); match; match = backticks.exec(line))
    runs.push({ at: match.index, length: match[0].length });
  const pieces: Piece[] = [];
  let cursor = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const open = runs[index]!;
    const closeAt = runs.findIndex((run, later) => later > index && run.length === open.length);
    if (closeAt === -1) continue;
    const close = runs[closeAt]!;
    pieces.push({ code: false, text: line.slice(cursor, open.at) });
    pieces.push({ code: true, text: line.slice(open.at + open.length, close.at) });
    cursor = close.at + close.length;
    index = closeAt;
  }
  pieces.push({ code: false, text: line.slice(cursor) });
  return pieces;
}

/**
 * 去掉一行正文里成对的双星号：左边那个后面紧跟非空白、右边那个前面紧跟非空白才算一对
 * （简化的 CommonMark 规则），所以 `a ** b`、`2**10` 原样保留；可以夹着行内代码配对。
 */
function dropBold(pieces: Piece[]): Piece[] {
  const marks: Array<{ piece: number; at: number }> = [];
  pieces.forEach((piece, index) => {
    if (piece.code) return;
    for (let at = piece.text.indexOf("**"); at !== -1; at = piece.text.indexOf("**", at + 2))
      marks.push({ piece: index, at });
  });
  const neighbour = (piece: number, at: number, step: 1 | -1): string => {
    const own = pieces[piece]!.text.charAt(at);
    if (own) return own;
    const next = pieces[piece + step];
    if (!next) return "";
    return step === 1 ? next.text.charAt(0) : next.text.charAt(next.text.length - 1);
  };
  const filled = (char: string) => char !== "" && !/\s/u.test(char);
  const drop = new Map<number, number[]>();
  let open: { piece: number; at: number } | null = null;
  for (const mark of marks) {
    if (open && filled(neighbour(mark.piece, mark.at - 1, -1))) {
      for (const end of [open, mark]) drop.set(end.piece, [...(drop.get(end.piece) ?? []), end.at]);
      open = null;
    } else if (filled(neighbour(mark.piece, mark.at + 2, 1))) {
      open = mark;
    }
  }
  return pieces.map((piece, index) => {
    const ats = drop.get(index);
    if (!ats) return piece;
    let text = piece.text;
    for (const at of [...ats].sort((a, b) => b - a)) text = text.slice(0, at) + text.slice(at + 2);
    return { code: false, text };
  });
}
