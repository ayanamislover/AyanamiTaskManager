/**
 * 样式守卫用的极简 CSS 级联模型。
 *
 * 为什么不用正则判断「有没有某条规则」：焦点环这类缺陷几乎都出在级联上——
 * 规则写了，但特指度不够、或者文件引入顺序在前，被别的规则压掉；正则看见了规则就放行，
 * 浏览器里却根本不生效。这里按规范做最小的一套：
 *   解析规则（含 @media / @supports / @starting-style 的嵌套）→ 按选择器规范算特指度 →
 *   在一棵元素模型上匹配选择器 → 按「!important → 特指度 → 源顺序」挑出每个属性的胜出声明。
 *
 * 认不出的语法（伪类、at-rule、媒体特性、CSS 嵌套）一律抛错：
 * 宁可让守卫红着要人补模型，也不能让它在看不懂的规则上静默放行。
 */

export type Specificity = readonly [number, number, number];
export type Combinator = " " | ">" | "+" | "~";

export type SimpleSelector =
  | { readonly kind: "type"; readonly name: string }
  | { readonly kind: "class"; readonly name: string }
  | { readonly kind: "id"; readonly name: string }
  | {
      readonly kind: "attribute";
      readonly name: string;
      readonly operator: string | null;
      readonly value: string | null;
    }
  | {
      readonly kind: "pseudo";
      readonly name: string;
      readonly selectors: readonly ComplexSelector[] | null;
      readonly argument: string | null;
    }
  /** :has() 相对选择器的锚点（即 :has 所在的那个元素）。 */
  | { readonly kind: "anchor" };

export type Compound = {
  readonly simples: readonly SimpleSelector[];
  readonly pseudoElement: string | null;
};

export type ComplexSelector = {
  readonly text: string;
  readonly compounds: readonly Compound[];
  readonly combinators: readonly Combinator[];
};

export type CssDeclaration = {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
};

export type CssRule = {
  readonly selectorText: string;
  readonly selectors: readonly ComplexSelector[];
  readonly declarations: readonly CssDeclaration[];
  /** 外层条件，例如 "@media (forced-colors: active)"、"@starting-style"。 */
  readonly conditions: readonly string[];
  readonly source: string;
  readonly line: number;
  /** 全局源顺序：越大越靠后。 */
  readonly order: number;
};

const SELECTOR_LIST_PSEUDOS = new Set(["is", "where", "not", "has"]);
const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);
const SUPPORTED_PSEUDOS = new Set([
  "root",
  "focus",
  "focus-visible",
  "focus-within",
  "hover",
  "active",
  "disabled",
  "enabled",
  "checked",
  "first-child",
  "last-child",
  "only-child",
  "nth-child",
  "placeholder-shown",
  ...SELECTOR_LIST_PSEUDOS,
]);
const FORM_CONTROL_TAGS = new Set(["button", "input", "select", "textarea", "fieldset"]);

/* ─── 文本扫描 ─── */

function blankComments(css: string): string {
  // 保留换行，行号才对得上。
  return css.replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " "));
}

function skipString(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === quote) return index;
  }
  throw new Error(`CSS 字符串没有闭合：${text.slice(start, start + 40)}`);
}

function closingIndex(text: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") index = skipString(text, index);
    else if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`「${opener}${closer}」不配对：${text.slice(open, open + 60)}`);
}

/** 在顶层（不在括号、方括号、字符串里）按分隔符切开。 */
export function splitTopLevel(text: string, separator: string | RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"' || char === "'") index = skipString(text, index);
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (
      depth === 0 &&
      (typeof separator === "string" ? char === separator : separator.test(char))
    ) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function nextTopLevel(text: string, from: number, end: number, stops: string): number {
  let depth = 0;
  for (let index = from; index < end; index += 1) {
    const char = text[index]!;
    if (char === '"' || char === "'") index = skipString(text, index);
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0 && stops.includes(char)) return index;
  }
  return -1;
}

/* ─── 规则解析 ─── */

export function parseDeclarations(body: string): CssDeclaration[] {
  return splitTopLevel(body, ";").flatMap((raw) => {
    const text = raw.trim();
    if (text === "") return [];
    const colon = text.indexOf(":");
    if (colon <= 0) throw new Error(`无法解析的声明：${text}`);
    const property = text.slice(0, colon).trim();
    let value = text.slice(colon + 1).trim();
    const important = /!\s*important$/iu.test(value);
    if (important) value = value.replace(/!\s*important$/iu, "").trim();
    return [
      { property: property.startsWith("--") ? property : property.toLowerCase(), value, important },
    ];
  });
}

export function parseCssRules(
  sources: readonly { readonly path: string; readonly text: string }[],
): CssRule[] {
  const rules: CssRule[] = [];
  for (const source of sources) {
    const text = blankComments(source.text);
    const lineAt = (index: number) => text.slice(0, index).split("\n").length;
    const walk = (start: number, end: number, conditions: readonly string[]) => {
      let index = start;
      for (;;) {
        while (index < end && /\s/u.test(text[index]!)) index += 1;
        if (index >= end) return;
        const stop = nextTopLevel(text, index, end, "{;}");
        if (stop < 0) throw new Error(`${source.path}:${lineAt(index)} 规则没有结束`);
        if (text[stop] === "}") throw new Error(`${source.path}:${lineAt(stop)} 多余的「}」`);
        const prelude = text.slice(index, stop).trim();
        if (text[stop] === ";") {
          if (!/^@(?:import|charset)\b/u.test(prelude)) {
            throw new Error(`${source.path}:${lineAt(index)} 无法识别的语句：${prelude}`);
          }
          index = stop + 1;
          continue;
        }
        const close = closingIndex(text, stop, "{", "}");
        if (prelude.startsWith("@")) {
          const name = /^@([\w-]+)/u.exec(prelude)?.[1] ?? "";
          if (name === "media" || name === "supports") {
            walk(stop + 1, close, [...conditions, prelude.replace(/\s+/gu, " ")]);
          } else if (name === "starting-style") {
            walk(stop + 1, close, [...conditions, "@starting-style"]);
          } else if (
            !["keyframes", "-webkit-keyframes", "font-face", "property", "page"].includes(name)
          ) {
            throw new Error(`${source.path}:${lineAt(index)} 级联模型不认识 at-rule：${prelude}`);
          }
        } else {
          const body = text.slice(stop + 1, close);
          if (body.includes("{")) {
            throw new Error(`${source.path}:${lineAt(index)} 级联模型不支持 CSS 嵌套：${prelude}`);
          }
          rules.push({
            selectorText: prelude.replace(/\s+/gu, " "),
            selectors: parseSelectorList(prelude),
            declarations: parseDeclarations(body),
            conditions,
            source: source.path,
            line: lineAt(index),
            order: rules.length,
          });
        }
        index = close + 1;
      }
    };
    walk(0, text.length, []);
  }
  return rules;
}

/* ─── 选择器解析与特指度 ─── */

export function parseSelectorList(text: string, relative = false): ComplexSelector[] {
  const parts = splitTopLevel(text, ",").map((part) => part.trim());
  if (parts.some((part) => part === "")) throw new Error(`空选择器：${text}`);
  return parts.map((part) => parseComplex(part, relative));
}

function parseComplex(text: string, relative: boolean): ComplexSelector {
  const compounds: Compound[] = [];
  const combinators: Combinator[] = [];
  let index = 0;
  const skipSpace = () => {
    const start = index;
    while (index < text.length && /\s/u.test(text[index]!)) index += 1;
    return index > start;
  };
  const isCombinator = (char: string | undefined): char is ">" | "+" | "~" =>
    char === ">" || char === "+" || char === "~";
  skipSpace();
  if (relative) {
    compounds.push({ simples: [{ kind: "anchor" }], pseudoElement: null });
    const char = text[index];
    if (isCombinator(char)) {
      combinators.push(char);
      index += 1;
      skipSpace();
    } else {
      combinators.push(" ");
    }
  }
  for (;;) {
    const [compound, next] = parseCompound(text, index);
    compounds.push(compound);
    index = next;
    const sawSpace = skipSpace();
    if (index >= text.length) break;
    const char = text[index];
    if (isCombinator(char)) {
      combinators.push(char);
      index += 1;
      skipSpace();
    } else if (sawSpace) {
      combinators.push(" ");
    } else {
      throw new Error(`无法解析选择器：${text}`);
    }
  }
  return { text, compounds, combinators };
}

function parseCompound(text: string, start: number): [Compound, number] {
  const simples: SimpleSelector[] = [];
  let pseudoElement: string | null = null;
  let index = start;
  const ident = () => {
    const match = /^-?[_a-zA-Z][\w-]*/u.exec(text.slice(index));
    if (!match) throw new Error(`选择器里缺标识符：${text}（位置 ${index}）`);
    index += match[0].length;
    return match[0];
  };
  while (index < text.length && !/[\s>+~]/u.test(text[index]!)) {
    const char = text[index]!;
    if (pseudoElement !== null) {
      // 伪元素后面只能再接用户动作类伪类（如 ::-webkit-scrollbar-thumb:hover）。这类规则只作用于伪元素，
      // 永远不会命中元素本身，所以只记特指度、不校验伪类名。
      if (char !== ":" || text[index + 1] === ":") {
        throw new Error(`伪元素后面不能再接选择器：${text}`);
      }
      index += 1;
      const name = ident().toLowerCase();
      if (text[index] === "(") index = closingIndex(text, index, "(", ")") + 1;
      simples.push({ kind: "pseudo", name, selectors: null, argument: null });
      continue;
    }
    if (char === "*") {
      simples.push({ kind: "type", name: "*" });
      index += 1;
    } else if (char === ".") {
      index += 1;
      simples.push({ kind: "class", name: ident() });
    } else if (char === "#") {
      index += 1;
      simples.push({ kind: "id", name: ident() });
    } else if (char === "[") {
      const close = closingIndex(text, index, "[", "]");
      const inner = text.slice(index + 1, close);
      const match = /^\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\s*$/u.exec(
        inner,
      );
      if (!match) throw new Error(`无法解析属性选择器：[${inner}]`);
      simples.push({
        kind: "attribute",
        name: match[1]!.toLowerCase(),
        operator: match[2] ?? null,
        value: match[3] ?? match[4] ?? match[5] ?? null,
      });
      index = close + 1;
    } else if (char === ":") {
      if (text[index + 1] === ":") {
        index += 2;
        pseudoElement = ident().toLowerCase();
        if (text[index] === "(") index = closingIndex(text, index, "(", ")") + 1;
        continue;
      }
      index += 1;
      const name = ident().toLowerCase();
      if (LEGACY_PSEUDO_ELEMENTS.has(name)) {
        pseudoElement = name;
        continue;
      }
      let argument: string | null = null;
      if (text[index] === "(") {
        const close = closingIndex(text, index, "(", ")");
        argument = text.slice(index + 1, close);
        index = close + 1;
      }
      simples.push(pseudoClass(name, argument, text));
    } else if (/[a-zA-Z]/u.test(char)) {
      simples.push({ kind: "type", name: ident().toLowerCase() });
    } else {
      throw new Error(`无法解析选择器字符「${char}」：${text}`);
    }
  }
  if (simples.length === 0 && pseudoElement === null) throw new Error(`空的复合选择器：${text}`);
  return [{ simples, pseudoElement }, index];
}

function pseudoClass(name: string, argument: string | null, context: string): SimpleSelector {
  if (!SUPPORTED_PSEUDOS.has(name)) {
    throw new Error(
      `级联模型不认识伪类 :${name}（${context}）——请在 css-cascade-model.ts 里补上它的匹配规则`,
    );
  }
  if (SELECTOR_LIST_PSEUDOS.has(name)) {
    if (argument === null) throw new Error(`:${name}() 缺参数：${context}`);
    return {
      kind: "pseudo",
      name,
      selectors: parseSelectorList(argument, name === "has"),
      argument,
    };
  }
  if (name === "nth-child") {
    if (argument === null || !/^\s*\d+\s*$/u.test(argument)) {
      throw new Error(`级联模型只支持 :nth-child(整数)：${context}`);
    }
    return { kind: "pseudo", name, selectors: null, argument: argument.trim() };
  }
  if (argument !== null) throw new Error(`:${name} 不应带参数：${context}`);
  return { kind: "pseudo", name, selectors: null, argument: null };
}

function addSpecificity(left: Specificity, right: Specificity): Specificity {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

export function compareSpecificity(left: Specificity, right: Specificity): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function maxSpecificity(selectors: readonly ComplexSelector[]): Specificity {
  return selectors
    .map(selectorSpecificity)
    .reduce<Specificity>(
      (best, next) => (compareSpecificity(next, best) > 0 ? next : best),
      [0, 0, 0],
    );
}

/** Selectors Level 4：:is / :not / :has 取参数里最高的那一个，:where 为 0。 */
export function selectorSpecificity(selector: ComplexSelector): Specificity {
  let total: Specificity = [0, 0, 0];
  for (const compound of selector.compounds) {
    if (compound.pseudoElement !== null) total = addSpecificity(total, [0, 0, 1]);
    for (const simple of compound.simples) {
      if (simple.kind === "id") total = addSpecificity(total, [1, 0, 0]);
      else if (simple.kind === "class" || simple.kind === "attribute") {
        total = addSpecificity(total, [0, 1, 0]);
      } else if (simple.kind === "type" && simple.name !== "*") {
        total = addSpecificity(total, [0, 0, 1]);
      } else if (simple.kind === "pseudo" && simple.name !== "where") {
        total = addSpecificity(
          total,
          simple.selectors ? maxSpecificity(simple.selectors) : [0, 1, 0],
        );
      }
    }
  }
  return total;
}

/* ─── 元素模型 ─── */

export type InteractionState = "focus" | "focus-visible" | "hover" | "active";

export type ModelElement = {
  readonly tag: string;
  readonly attributes: Map<string, string>;
  readonly states: Set<InteractionState>;
  parent: ModelElement | null;
  readonly children: ModelElement[];
  /** 元素自己直接含文字（forced-colors 下要检查字色是否读得清）。 */
  hasText: boolean;
};

export function element(
  tag: string,
  attributes: Record<string, string> = {},
  children: ModelElement[] = [],
  hasText = false,
): ModelElement {
  const node: ModelElement = {
    tag: tag.toLowerCase(),
    attributes: new Map(Object.entries(attributes)),
    states: new Set(),
    parent: null,
    children: [],
    hasText,
  };
  for (const child of children) appendChild(node, child);
  return node;
}

export function appendChild(parent: ModelElement, child: ModelElement): ModelElement {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

const VOID_TAGS = new Set([
  "area",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;|&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

/** 把 React 服务端渲染出的 markup 解析成元素模型（只认元素与属性，文本忽略）。 */
export function parseMarkup(html: string): ModelElement[] {
  const fragment = element("#fragment");
  let current = fragment;
  const tokens =
    /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+)/gu;
  for (const match of html.matchAll(tokens)) {
    if (match[5] !== undefined) {
      if (match[5].trim() !== "") current.hasText = true;
      continue;
    }
    if (match[1]) {
      if (current.tag !== match[1].toLowerCase() || !current.parent) {
        throw new Error(`markup 标签不配对：</${match[1]}>`);
      }
      current = current.parent;
      continue;
    }
    if (!match[2]) continue;
    const attributes: Record<string, string> = {};
    for (const attribute of (match[3] ?? "").matchAll(
      /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu,
    )) {
      attributes[attribute[1]!.toLowerCase()] = decodeEntities(
        attribute[2] ?? attribute[3] ?? attribute[4] ?? "",
      );
    }
    const node = appendChild(current, element(match[2], attributes));
    if (!VOID_TAGS.has(node.tag) && match[4] !== "/") current = node;
  }
  if (current !== fragment) throw new Error(`markup 有未闭合的 <${current.tag}>`);
  for (const child of fragment.children) child.parent = null;
  return fragment.children;
}

function classesOf(node: ModelElement): Set<string> {
  return new Set((node.attributes.get("class") ?? "").split(/\s+/u).filter(Boolean));
}

function rootOf(node: ModelElement): ModelElement {
  let root = node;
  while (root.parent) root = root.parent;
  return root;
}

export function descendants(node: ModelElement): ModelElement[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function hasFocus(node: ModelElement): boolean {
  return node.states.has("focus") || node.states.has("focus-visible");
}

/* ─── 匹配 ─── */

function matchSimple(
  simple: SimpleSelector,
  node: ModelElement,
  anchor: ModelElement | null,
): boolean {
  switch (simple.kind) {
    case "type":
      return simple.name === "*" || node.tag === simple.name;
    case "class":
      return classesOf(node).has(simple.name);
    case "id":
      return node.attributes.get("id") === simple.name;
    case "anchor":
      return node === anchor;
    case "attribute": {
      const actual = node.attributes.get(simple.name);
      if (actual === undefined) return false;
      const expected = simple.value ?? "";
      switch (simple.operator) {
        case null:
          return true;
        case "=":
          return actual === expected;
        case "~=":
          return actual.split(/\s+/u).includes(expected);
        case "^=":
          return expected !== "" && actual.startsWith(expected);
        case "$=":
          return expected !== "" && actual.endsWith(expected);
        case "*=":
          return expected !== "" && actual.includes(expected);
        case "|=":
          return actual === expected || actual.startsWith(`${expected}-`);
        default:
          throw new Error(`未知属性运算符：${simple.operator}`);
      }
    }
    case "pseudo":
      return matchPseudo(simple, node);
  }
}

function matchPseudo(
  simple: Extract<SimpleSelector, { kind: "pseudo" }>,
  node: ModelElement,
): boolean {
  const siblings = node.parent?.children ?? [node];
  switch (simple.name) {
    case "is":
    case "where":
      return simple.selectors!.some((selector) => matches(node, selector));
    case "not":
      return !simple.selectors!.some((selector) => matches(node, selector));
    case "has":
      return simple.selectors!.some((selector) =>
        descendants(rootOf(node)).some(
          (candidate) => candidate !== node && matches(candidate, selector, node),
        ),
      );
    case "root":
      return node.parent === null;
    case "focus":
      return hasFocus(node);
    case "focus-visible":
      return node.states.has("focus-visible");
    case "focus-within":
      return hasFocus(node) || descendants(node).some(hasFocus);
    case "hover":
    case "active":
      return node.states.has(simple.name);
    case "disabled":
      return FORM_CONTROL_TAGS.has(node.tag) && node.attributes.has("disabled");
    case "enabled":
      return FORM_CONTROL_TAGS.has(node.tag) && !node.attributes.has("disabled");
    case "checked":
      return node.attributes.has("checked");
    case "placeholder-shown":
      return (
        (node.tag === "input" || node.tag === "textarea") &&
        node.attributes.has("placeholder") &&
        (node.attributes.get("value") ?? "") === ""
      );
    case "first-child":
      return siblings[0] === node;
    case "last-child":
      return siblings[siblings.length - 1] === node;
    case "only-child":
      return siblings.length === 1;
    case "nth-child":
      return siblings.indexOf(node) + 1 === Number(simple.argument);
    default:
      throw new Error(`级联模型不认识伪类 :${simple.name}`);
  }
}

/** 选择器是否命中元素（anchor 只给 :has() 的相对选择器用）。伪元素规则不作用于元素本身。 */
export function matches(
  node: ModelElement,
  selector: ComplexSelector,
  anchor: ModelElement | null = null,
): boolean {
  const { compounds, combinators } = selector;
  const from = (index: number, candidate: ModelElement): boolean => {
    const compound = compounds[index]!;
    if (compound.pseudoElement !== null) return false;
    if (!compound.simples.every((simple) => matchSimple(simple, candidate, anchor))) return false;
    if (index === 0) return true;
    const combinator = combinators[index - 1]!;
    if (combinator === ">") return candidate.parent !== null && from(index - 1, candidate.parent);
    if (combinator === " ") {
      for (let parent = candidate.parent; parent; parent = parent.parent) {
        if (from(index - 1, parent)) return true;
      }
      return false;
    }
    const siblings = candidate.parent?.children ?? [];
    const position = siblings.indexOf(candidate);
    if (combinator === "+") return position > 0 && from(index - 1, siblings[position - 1]!);
    return siblings.slice(0, Math.max(0, position)).some((sibling) => from(index - 1, sibling));
  };
  return from(compounds.length - 1, node);
}

export function querySelectorAll(root: ModelElement, selectorText: string): ModelElement[] {
  const selectors = parseSelectorList(selectorText);
  return [root, ...descendants(root)].filter((node) =>
    selectors.some((selector) => matches(node, selector)),
  );
}

export function querySelector(root: ModelElement, selectorText: string): ModelElement {
  const found = querySelectorAll(root, selectorText);
  if (found.length !== 1) {
    throw new Error(`模型里「${selectorText}」应恰好一个，实际 ${found.length} 个`);
  }
  return found[0]!;
}

/* ─── 级联 ─── */

export type CascadeEnvironment = {
  readonly forcedColors: boolean;
  /** 触屏设备没有悬停、指针也不精确。 */
  readonly finePointer: boolean;
  readonly viewportWidth: number;
};

function mediaFeatureHolds(feature: string, environment: CascadeEnvironment): boolean {
  const match = /^\(\s*([\w-]+)\s*:\s*([^)]+?)\s*\)$/u.exec(feature.trim());
  if (!match) throw new Error(`级联模型不认识媒体特性：${feature}`);
  const [, name, value] = match as unknown as [string, string, string];
  switch (`${name}:${value}`) {
    case "forced-colors:active":
      return environment.forcedColors;
    case "forced-colors:none":
      return !environment.forcedColors;
    case "prefers-reduced-motion:reduce":
    case "prefers-reduced-transparency:reduce":
    case "prefers-contrast:more":
    case "prefers-color-scheme:dark":
      return false;
    case "prefers-reduced-motion:no-preference":
    case "prefers-reduced-transparency:no-preference":
    case "prefers-contrast:no-preference":
    case "prefers-color-scheme:light":
      return true;
    case "hover:hover":
    case "any-hover:hover":
    case "pointer:fine":
    case "any-pointer:fine":
      return environment.finePointer;
    case "hover:none":
    case "pointer:coarse":
    case "any-pointer:coarse":
      return !environment.finePointer;
    default:
      break;
  }
  const width = /^(\d+(?:\.\d+)?)px$/u.exec(value);
  if (width && name === "max-width") return environment.viewportWidth <= Number(width[1]);
  if (width && name === "min-width") return environment.viewportWidth >= Number(width[1]);
  throw new Error(`级联模型不认识媒体特性：${feature}`);
}

export function conditionHolds(condition: string, environment: CascadeEnvironment): boolean {
  if (condition === "@starting-style") return false;
  if (condition.startsWith("@supports")) return true;
  const query = /^@media\s+(.+)$/u.exec(condition)?.[1];
  if (!query) throw new Error(`级联模型不认识条件：${condition}`);
  return splitTopLevel(query, ",").some((alternative) => {
    const text = alternative.trim().replace(/^(?:only\s+)?(?:screen|all)\s+and\s+/u, "");
    const negated = /^not\s+/u.test(text);
    const holds = text
      .replace(/^not\s+/u, "")
      .split(/\s+and\s+/u)
      .every((feature) => mediaFeatureHolds(feature, environment));
    return negated ? !holds : holds;
  });
}

const OUTLINE_STYLES = new Set([
  "none",
  "hidden",
  "auto",
  "solid",
  "dotted",
  "dashed",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
]);
const SIDES = ["top", "right", "bottom", "left"] as const;

function isWidthToken(token: string): boolean {
  return /^(?:0|-?\d*\.?\d+(?:px|em|rem)|thin|medium|thick)$/u.test(token);
}

function lineShorthand(prefix: string, value: string): CssDeclaration[] {
  const tokens = splitTopLevel(value.trim(), /\s/u).filter(Boolean);
  let style = "none";
  let width = "medium";
  let color = "currentcolor";
  for (const token of tokens) {
    if (OUTLINE_STYLES.has(token.toLowerCase())) style = token.toLowerCase();
    else if (isWidthToken(token)) width = token;
    else color = token;
  }
  return [
    { property: `${prefix}-style`, value: style, important: false },
    { property: `${prefix}-width`, value: width, important: false },
    { property: `${prefix}-color`, value: color, important: false },
  ];
}

function boxSides(property: string, value: string): CssDeclaration[] {
  const tokens = splitTopLevel(value.trim(), /\s/u).filter(Boolean);
  const [top, right = top, bottom = top, left = right] = tokens;
  const values = [top, right, bottom, left];
  return SIDES.map((side, index) => ({
    property: property.replace("border-", `border-${side}-`),
    value: values[index] ?? "",
    important: false,
  }));
}

/** 把本守卫关心的简写展开成长写；其余属性原样返回。 */
export function expandDeclaration(declaration: CssDeclaration): CssDeclaration[] {
  const { property, value, important } = declaration;
  let expanded: CssDeclaration[];
  if (property === "outline") expanded = lineShorthand("outline", value);
  else if (property === "border") {
    expanded = SIDES.flatMap((side) => lineShorthand(`border-${side}`, value));
  } else if (/^border-(?:top|right|bottom|left)$/u.test(property)) {
    expanded = lineShorthand(property, value);
  } else if (/^border-(?:width|style|color)$/u.test(property)) {
    expanded = boxSides(property, value);
  } else if (property === "background") {
    // 只关心底色：简写整体当作 background-color，好和单写的 background-color 按级联比较。
    expanded = [{ property: "background-color", value, important: false }];
  } else {
    return [declaration];
  }
  return expanded.map((entry) => ({ ...entry, important }));
}

export type ComputedDeclaration = {
  readonly value: string;
  readonly rule: CssRule;
  readonly specificity: Specificity;
};

/** 按「条件成立 → !important → 特指度 → 源顺序」算出每个（长写）属性的胜出声明。 */
export function cascade(
  rules: readonly CssRule[],
  node: ModelElement,
  environment: CascadeEnvironment,
): Map<string, ComputedDeclaration & { readonly important: boolean }> {
  const winners = new Map<string, ComputedDeclaration & { readonly important: boolean }>();
  for (const rule of rules) {
    if (!rule.conditions.every((condition) => conditionHolds(condition, environment))) continue;
    const matching = rule.selectors.filter((selector) => matches(node, selector));
    if (matching.length === 0) continue;
    const specificity = maxSpecificity(matching);
    for (const declaration of rule.declarations.flatMap(expandDeclaration)) {
      const current = winners.get(declaration.property);
      const wins =
        !current ||
        (declaration.important && !current.important) ||
        (declaration.important === current.important &&
          compareSpecificity(specificity, current.specificity) >= 0);
      if (wins) {
        winners.set(declaration.property, {
          value: declaration.value,
          rule,
          specificity,
          important: declaration.important,
        });
      }
    }
  }
  return winners;
}

export function formatSpecificity(specificity: Specificity): string {
  return `(${specificity.join(",")})`;
}

/* ─── forced-colors：系统换色之后还看得见什么 ───
 * 高对比度模式下，作者写的非系统色（color、background-color、border-color、outline-color）都被换成系统色，
 * box-shadow 与渐变底图被去掉；系统色关键字（Highlight、CanvasText…）和 forced-color-adjust: none 的元素例外。
 * 状态如果只靠底色或投影表达，在这里就会「两态长得一模一样」。 */

const SYSTEM_COLOR_NAMES = [
  "AccentColor",
  "AccentColorText",
  "ActiveText",
  "ButtonBorder",
  "ButtonFace",
  "ButtonText",
  "Canvas",
  "CanvasText",
  "Field",
  "FieldText",
  "GrayText",
  "Highlight",
  "HighlightText",
  "LinkText",
  "Mark",
  "MarkText",
  "SelectedItem",
  "SelectedItemText",
  "VisitedText",
];
const SYSTEM_COLORS = new Map(SYSTEM_COLOR_NAMES.map((name) => [name.toLowerCase(), name]));

/** 系统色底上允许的前景；其余组合在用户的高对比度主题里不保证读得清。 */
const READABLE_ON: Readonly<Record<string, readonly string[]>> = {
  Canvas: ["CanvasText", "LinkText", "VisitedText", "ActiveText", "GrayText", "ButtonText"],
  ButtonFace: ["ButtonText", "GrayText"],
  Field: ["FieldText", "GrayText"],
  Highlight: ["HighlightText"],
  HighlightText: ["Highlight"],
  CanvasText: ["Canvas"],
  ButtonText: ["ButtonFace"],
  Mark: ["MarkText"],
  SelectedItem: ["SelectedItemText"],
  AccentColor: ["AccentColorText"],
};

/** 值里出现的系统色关键字（规范大小写），没有就是 null。 */
export function systemColorIn(value: string | undefined): string | null {
  if (!value) return null;
  for (const token of splitTopLevel(value.trim(), /\s/u)) {
    const name = SYSTEM_COLORS.get(token.toLowerCase());
    if (name) return name;
  }
  return null;
}

export const FORCED_PHONE: CascadeEnvironment = {
  forcedColors: true,
  finePointer: false,
  viewportWidth: 375,
};

function declaredValue(
  rules: readonly CssRule[],
  node: ModelElement,
  environment: CascadeEnvironment,
  property: string,
): string | undefined {
  return cascade(rules, node, environment).get(property)?.value;
}

/** forced-color-adjust 会继承：沿祖先找第一处声明。 */
function keepsAuthorColors(
  rules: readonly CssRule[],
  node: ModelElement,
  environment: CascadeEnvironment,
): boolean {
  for (let current: ModelElement | null = node; current; current = current.parent) {
    const value = declaredValue(rules, current, environment, "forced-color-adjust");
    if (value !== undefined && value !== "inherit") return value === "none";
  }
  return false;
}

function rendered(
  rules: readonly CssRule[],
  node: ModelElement,
  environment: CascadeEnvironment,
): boolean {
  return (
    !node.attributes.has("hidden") && declaredValue(rules, node, environment, "display") !== "none"
  );
}

/** forced-colors 下一个元素自己的底：系统色原样保留；其他不透明的底被换成画布色；透明或没写为 null。 */
function forcedBackground(
  rules: readonly CssRule[],
  node: ModelElement,
  environment: CascadeEnvironment,
): string | null {
  const value = declaredValue(rules, node, environment, "background-color");
  if (value === undefined || /^(?:transparent|none|inherit)$/iu.test(value.trim())) return null;
  if (keepsAuthorColors(rules, node, environment)) return value;
  return systemColorIn(value) ?? "Canvas";
}

/** 元素背后实际的底：沿祖先找第一处画出来的底，默认画布色。 */
function backgroundBehind(
  rules: readonly CssRule[],
  node: ModelElement,
  environment: CascadeEnvironment,
): string {
  for (let current = node.parent; current; current = current.parent) {
    const value = forcedBackground(rules, current, environment);
    if (value) return value;
  }
  return "Canvas";
}

/** 字色会继承：沿祖先找第一处声明；非系统色被换成 CanvasText。 */
function forcedTextColor(
  rules: readonly CssRule[],
  node: ModelElement,
  environment: CascadeEnvironment,
): string {
  for (let current: ModelElement | null = node; current; current = current.parent) {
    const value = declaredValue(rules, current, environment, "color");
    if (value === undefined || /^(?:inherit|currentcolor)$/iu.test(value)) continue;
    if (keepsAuthorColors(rules, current, environment)) return value;
    return systemColorIn(value) ?? "CanvasText";
  }
  return "CanvasText";
}

/**
 * 一棵子树在 forced-colors 下留得下来的外观，一行一个元素。
 * 只记高对比度里真正看得见的东西：和背后不同的底、有字或图标的元素的字色、实际画出来的边框与 outline、
 * 透明度、字重、文字装饰，以及「本身画得出来」的元素的 transform——开关滑块被去色后和轨道一个颜色，
 * 位移也就看不见了。
 */
export function forcedColorsAppearance(
  rules: readonly CssRule[],
  root: ModelElement,
  environment: CascadeEnvironment = FORCED_PHONE,
): string[] {
  if (!environment.forcedColors) {
    throw new Error("forcedColorsAppearance 只用于 forced-colors 环境");
  }
  const lines: string[] = [];
  const visit = (node: ModelElement, depth: number) => {
    if (!rendered(rules, node, environment)) return;
    const style = cascade(rules, node, environment);
    const get = (name: string) => style.get(name)?.value;
    const keep = keepsAuthorColors(rules, node, environment);
    const lineColor = (value: string | undefined) =>
      keep ? (value ?? "currentcolor") : (systemColorIn(value) ?? "CanvasText");
    const parts: string[] = [];
    const background = forcedBackground(rules, node, environment);
    const visibleBackground =
      background !== null && background !== backgroundBehind(rules, node, environment);
    if (visibleBackground) parts.push(`底 ${background}`);
    if (node.hasText || node.tag === "svg") {
      parts.push(`字 ${forcedTextColor(rules, node, environment)}`);
    }
    let drawsLine = false;
    for (const line of ["border-top", "border-right", "border-bottom", "border-left", "outline"]) {
      const lineStyle = get(`${line}-style`) ?? "none";
      const width = get(`${line}-width`) ?? "medium";
      if (lineStyle === "none" || lineStyle === "hidden" || /^0(?:px)?$/u.test(width)) continue;
      drawsLine = true;
      parts.push(`${line} ${lineStyle} ${width} ${lineColor(get(`${line}-color`))}`);
    }
    const shadow = get("box-shadow");
    if (keep && shadow && shadow !== "none") parts.push(`投影 ${shadow}`);
    for (const name of ["opacity", "font-weight", "text-decoration", "text-decoration-line"]) {
      const value = get(name);
      // opacity: 1 与没写一样，不算差别。
      if (value !== undefined && !(name === "opacity" && Number(value) === 1)) {
        parts.push(`${name} ${value}`);
      }
    }
    const paints = node.tag === "svg" || node.hasText || visibleBackground || drawsLine;
    const transform = get("transform");
    if (paints && transform && transform !== "none") parts.push(`transform ${transform}`);
    lines.push(`${"  ".repeat(depth)}<${node.tag}>${parts.length ? ` ${parts.join("；")}` : ""}`);
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return lines;
}

/** forced-colors 下：系统色底上的字和图标，必须用与该底配对的系统前景色（Highlight 底配 HighlightText）。 */
export function forcedColorsContrastViolations(
  rules: readonly CssRule[],
  root: ModelElement,
  environment: CascadeEnvironment = FORCED_PHONE,
): string[] {
  const violations: string[] = [];
  const visit = (node: ModelElement) => {
    if (!rendered(rules, node, environment)) return;
    // 只查真正有字或图标的元素：开关滑块这类纯色块没有前景，不需要配色。
    if (node.hasText || node.tag === "svg") {
      const keep = keepsAuthorColors(rules, node, environment);
      // forced-color-adjust: auto 时，Chromium 会在文字后面垫一块 Canvas 色的背板（readability backplate），
      // 元素自己的底换成 Highlight 也垫不过它：HighlightText 的字压在白板上就成了一块白。
      // 所以「选中项用 Highlight 底 + HighlightText 字」必须配 forced-color-adjust: none。svg 图标不垫板。
      const onBackplate = !keep && node.hasText;
      const rawBackground = onBackplate
        ? "Canvas"
        : (forcedBackground(rules, node, environment) ??
          backgroundBehind(rules, node, environment));
      const background = systemColorIn(rawBackground) ?? rawBackground;
      const rawColor = forcedTextColor(rules, node, environment);
      const color = systemColorIn(rawColor) ?? rawColor;
      // 底不是系统色（forced-color-adjust: none 保留了作者配色）时无从判断，交给作者。
      const allowed = READABLE_ON[background];
      if (allowed && !allowed.includes(color)) {
        const classes = node.attributes.get("class");
        violations.push(
          `<${node.tag}${classes ? ` class="${classes}"` : ""}> 在 ${background}${onBackplate ? "（文字背板）" : " 底"}上用的是 ${color}`,
        );
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return violations;
}

export type ForcedStateCase = {
  readonly label: string;
  /** 选中 / 开启 / 当前那一态的元素（挂在完整文档里，祖先选择器才命中得了）。 */
  readonly on: ModelElement;
  readonly off: ModelElement;
};

/** 每个状态对：forced-colors 下两态必须看得出差别，且系统色底上的字读得清。 */
export function forcedStateViolations(
  rules: readonly CssRule[],
  cases: readonly ForcedStateCase[],
  environment: CascadeEnvironment = FORCED_PHONE,
): string[] {
  const violations: string[] = [];
  for (const { label, on, off } of cases) {
    const onLook = forcedColorsAppearance(rules, on, environment);
    const offLook = forcedColorsAppearance(rules, off, environment);
    if (onLook.join("\n") === offLook.join("\n")) {
      violations.push(
        `${label}：forced-colors 下两态看起来一样（只靠会被系统去掉的底色/投影区分）：${onLook.join(" | ")}`,
      );
    }
    for (const [state, node] of [
      ["选中", on],
      ["未选中", off],
    ] as const) {
      for (const problem of forcedColorsContrastViolations(rules, node, environment)) {
        violations.push(`${label}（${state}）：${problem}`);
      }
    }
  }
  return violations;
}

/** 只靠底色画出来的元素（进度条填充、状态灯）：forced-colors 下必须还画得出来。 */
export function forcedInvisibleViolations(
  rules: readonly CssRule[],
  cases: readonly { readonly label: string; readonly node: ModelElement }[],
  environment: CascadeEnvironment = FORCED_PHONE,
): string[] {
  return cases.flatMap(({ label, node }) => {
    const [look] = forcedColorsAppearance(rules, node, environment);
    // 外观里只记和背后不同的底，所以出现「底」「边框」「outline」就说明画得出来。
    return look && /(?:底 |border-|outline )/u.test(look)
      ? []
      : [`${label}：forced-colors 下什么都画不出来（${look ?? "未渲染"}）`];
  });
}
