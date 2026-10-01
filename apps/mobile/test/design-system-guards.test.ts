import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  appendChild,
  cascade,
  element,
  formatSpecificity,
  parseCssRules,
  parseMarkup,
  querySelector,
  selectorSpecificity,
  type CascadeEnvironment,
  type ComplexSelector,
  type Compound,
  type CssRule,
  type ModelElement,
  type SimpleSelector,
} from "../../../packages/ui/test/css-cascade-model.js";
import {
  mobileCssSources,
  mobileEntry,
  mobileProductionSources,
  mobileSourceRoot,
  readMobileCssGraph,
  recursiveFiles,
  relativeToRepository,
  type CssSourceFile,
} from "../../../packages/ui/test/css-source-graph.js";
import { Select } from "../src/ui/select.js";

/*
 * 手机端的设计系统守卫（与桌面端 apps/desktop/test/design-system-guards.test.ts 对应）。
 *
 * 规则：一个字段只能有一个元素画焦点环——谁画边框谁画环。外壳（.field-shell）画边框和环，
 * 壳里的控件（输入框、自绘下拉的触发器）不画；高对比度（forced-colors）下把控件那一环放回来；
 * 下拉一律自绘，不用原生 select。
 *
 * 焦点环的判断不靠正则找规则，而是在一棵取自真实组件 markup 的元素模型上跑级联
 * （packages/ui/test/css-cascade-model.ts）：规则写了却被特指度或文件顺序压掉，这里一样会红。
 */

const PHONE: CascadeEnvironment = { forcedColors: false, finePointer: false, viewportWidth: 375 };
const PHONE_FORCED: CascadeEnvironment = { ...PHONE, forcedColors: true };
const SHELL_CLASS = "field-shell";

/* ─── 真实组件 markup → 元素模型 ─── */

function renderSelect(): ModelElement[] {
  return parseMarkup(
    renderToStaticMarkup(
      createElement(Select, {
        id: "guard-project",
        label: "项目",
        value: "ATM",
        options: [
          { value: "ATM", label: "任务管理", hint: "ATM" },
          { value: "WEB", label: "网站", hint: "WEB" },
        ],
        onChange: () => undefined,
      }),
    ),
  );
}

function classList(node: ModelElement): string[] {
  return (node.attributes.get("class") ?? "").split(/\s+/u).filter(Boolean);
}

/** 自绘下拉的类名一律从真实 markup 读：组件改名后守卫跟着走，不会对着一个不存在的类空转。 */
function selectClasses() {
  const [root] = renderSelect();
  if (!root) throw new Error("Select 没有渲染出任何元素");
  const trigger = root.children.find((child) => child.attributes.get("role") === "combobox");
  if (!trigger) throw new Error("Select 的外壳下面没有直接挂 combobox 触发器");
  const shell = classList(root).filter((name) => name !== SHELL_CLASS);
  const [triggerClass] = classList(trigger);
  if (shell.length !== 1 || !triggerClass) throw new Error("Select 外壳或触发器的类名不符合预期");
  return { shell: shell[0]!, trigger: triggerClass };
}

const SELECT = selectClasses();

/** 弹层只在打开后才渲染，服务端 markup 里没有：按 select.tsx 的结构补上（类名由下面的用例绑定到源码）。 */
function appendOpenPopover(shell: ModelElement): void {
  shell.attributes.set("data-open", "true");
  appendChild(
    shell,
    element("div", { class: "select-popover", role: "listbox" }, [
      element("button", {
        type: "button",
        class: "select-option",
        role: "option",
        "aria-selected": "true",
        "data-selected": "true",
      }),
      element("button", {
        type: "button",
        class: "select-option",
        role: "option",
        "aria-selected": "false",
        "data-selected": "false",
      }),
    ]),
  );
}

/**
 * 一张表单：自绘下拉、单行输入框、多行输入框，外加一个探针——输入框壳里的辅助按钮
 * （例如清空 ×）。压环规则一旦泛化成 `button`，探针和下拉选项的焦点环会跟着没了。
 */
function fieldDocument(selectOpen = false): ModelElement {
  const form = element("form", { class: "form" });
  const html = element("html", { lang: "zh-CN", "data-theme": "light" }, [
    element("body", {}, [
      element("div", { id: "root" }, [element("main", { class: "screen" }, [form])]),
    ]),
  ]);
  const selectField = appendChild(
    form,
    element("div", { class: "field" }, [element("label", { for: "guard-project" })]),
  );
  for (const node of renderSelect()) appendChild(selectField, node);
  if (selectOpen) appendOpenPopover(querySelector(html, `.${SELECT.shell}.${SHELL_CLASS}`));
  appendChild(
    form,
    element("div", { class: "field" }, [
      element("label", { for: "guard-title" }),
      element("div", { class: `input-shell ${SHELL_CLASS}` }, [
        element("input", { id: "guard-title", placeholder: "一句话说清要做什么" }),
        element("button", { type: "button", class: "guard-probe-clear", "aria-label": "清空" }),
      ]),
    ]),
  );
  appendChild(
    form,
    element("div", { class: "field" }, [
      element("label", { for: "guard-description" }),
      element("div", { class: `input-shell ${SHELL_CLASS} is-multiline` }, [
        element("textarea", { id: "guard-description", rows: "5" }),
      ]),
    ]),
  );
  return html;
}

type FieldCase = {
  readonly label: string;
  readonly shell: string;
  readonly control: string;
  /** 文本框鼠标/触摸聚焦同样成立 :focus-visible；按钮不成立。 */
  readonly pointerFocusIsVisible: boolean;
};

const FIELD_CASES: readonly FieldCase[] = [
  {
    label: "下拉触发器",
    shell: `.${SELECT.shell}.${SHELL_CLASS}`,
    control: `.${SELECT.trigger}`,
    pointerFocusIsVisible: false,
  },
  {
    label: "单行输入框",
    shell: `.input-shell.${SHELL_CLASS}:not(.is-multiline)`,
    control: "input",
    pointerFocusIsVisible: true,
  },
  {
    label: "多行输入框",
    shell: `.input-shell.${SHELL_CLASS}.is-multiline`,
    control: "textarea",
    pointerFocusIsVisible: true,
  },
];

/* ─── 从级联结果读「画没画环 / 边框」 ─── */

type Winner = ReturnType<typeof cascade> extends Map<string, infer V> ? V : never;

function origin(winner: Winner | undefined): string {
  if (!winner) return "UA 默认";
  return `${winner.rule.source}:${winner.rule.line} ${winner.rule.selectorText} ${formatSpecificity(winner.specificity)}`;
}

const UA_BORDERED = new Set(["button", "input", "textarea", "select"]);

function ringOf(rules: readonly CssRule[], node: ModelElement, environment: CascadeEnvironment) {
  const style = cascade(rules, node, environment);
  // 作者样式没写 outline 时，浏览器自带的 :focus-visible { outline: auto } 会画一圈。
  const outlineStyle =
    style.get("outline-style")?.value ?? (node.states.has("focus-visible") ? "auto" : "none");
  const outlineWidth = style.get("outline-width")?.value ?? "medium";
  const outline =
    outlineStyle !== "none" && outlineStyle !== "hidden" && !/^0(?:px)?$/u.test(outlineWidth)
      ? `${outlineWidth} ${outlineStyle} ${style.get("outline-color")?.value ?? "currentcolor"}`
      : null;
  const shadow = style.get("box-shadow")?.value ?? "none";
  // forced-colors 下 box-shadow 被系统强制成 none：那里只有 outline 能当焦点指示。
  const boxShadow = environment.forcedColors || shadow === "none" ? null : shadow;
  return {
    outline,
    boxShadow,
    color: style.get("outline-color")?.value ?? null,
    from: origin(style.get("outline-style")),
    shadowFrom: origin(style.get("box-shadow")),
  };
}

function borderOf(rules: readonly CssRule[], node: ModelElement): string | null {
  const style = cascade(rules, node, PHONE);
  const drawn = (["top", "right", "bottom", "left"] as const).filter((side) => {
    const sideStyle =
      style.get(`border-${side}-style`)?.value ?? (UA_BORDERED.has(node.tag) ? "inset" : "none");
    const width = style.get(`border-${side}-width`)?.value ?? "medium";
    return sideStyle !== "none" && sideStyle !== "hidden" && !/^0(?:px)?$/u.test(width);
  });
  return drawn.length === 0
    ? null
    : `${drawn.join("/")}（${origin(style.get("border-top-style"))}）`;
}

function focus(node: ModelElement, visible: boolean): void {
  node.states.add("focus");
  if (visible) node.states.add("focus-visible");
}

/* ─── 守卫一：级联实测焦点环 ─── */

export function fieldFocusViolations(sources: readonly CssSourceFile[]): string[] {
  const rules = parseCssRules(sources);
  const violations: string[] = [];
  for (const field of FIELD_CASES) {
    for (const input of ["键盘", "触摸"] as const) {
      const document = fieldDocument();
      const shell = querySelector(document, field.shell);
      const control = querySelector(shell, field.control);
      const visible = input === "键盘" || field.pointerFocusIsVisible;
      focus(control, visible);
      const shellRing = ringOf(rules, shell, PHONE);
      const controlRing = ringOf(rules, control, PHONE);
      const shellPaints = Boolean(shellRing.outline ?? shellRing.boxShadow);
      if (visible && !shellPaints) {
        violations.push(`${field.label}：${input}聚焦时外壳没有画焦点环（${shellRing.from}）`);
      }
      if (!visible && shellPaints) {
        violations.push(
          `${field.label}：${input}聚焦（非 :focus-visible）时外壳也画了环（${shellRing.from}）——外壳要用 :has(:focus-visible)，不能用 :focus-within`,
        );
      }
      if (controlRing.outline) {
        violations.push(
          `${field.label}：${input}聚焦时控件自己画了 outline ${controlRing.outline}（${controlRing.from}），和外壳成了双重框`,
        );
      }
      if (controlRing.boxShadow) {
        violations.push(
          `${field.label}：${input}聚焦时控件自己画了 box-shadow ${controlRing.boxShadow}（${controlRing.shadowFrom}），和外壳成了双重框`,
        );
      }
      if (input === "键盘") {
        if (!borderOf(rules, shell)) violations.push(`${field.label}：外壳没有画边框`);
        const controlBorder = borderOf(rules, control);
        if (controlBorder) violations.push(`${field.label}：控件自己也画了边框 ${controlBorder}`);
      }
    }

    const document = fieldDocument();
    const control = querySelector(querySelector(document, field.shell), field.control);
    focus(control, true);
    const forced = ringOf(rules, control, PHONE_FORCED);
    if (!forced.outline || forced.color !== "Highlight") {
      violations.push(
        `${field.label}：forced-colors 下控件没有用 Highlight 把焦点环放回来（outline=${forced.outline ?? "none"}，${forced.from}）`,
      );
    }
  }

  const probes = [
    { label: "输入框壳里的辅助按钮", selector: ".guard-probe-clear", open: false },
    { label: "下拉弹层里的选项", selector: '.select-option[data-selected="true"]', open: true },
  ];
  for (const probe of probes) {
    for (const environment of [PHONE, PHONE_FORCED]) {
      const node = querySelector(fieldDocument(probe.open), probe.selector);
      focus(node, true);
      const ring = ringOf(rules, node, environment);
      if (!ring.outline && !ring.boxShadow) {
        violations.push(
          `${probe.label}：${environment.forcedColors ? "forced-colors 下" : ""}键盘聚焦时没有焦点环（${ring.from}）——壳内压环规则不能泛化成 button`,
        );
      }
    }
  }
  return violations;
}

/* ─── 守卫二：清零控件边框 / 给外壳画边框的规则必须点名 field-shell ─── */

function compoundMentions(compound: Compound, test: (simple: SimpleSelector) => boolean): boolean {
  return compound.simples.some(
    (simple) =>
      test(simple) ||
      (simple.kind === "pseudo" &&
        (simple.name === "is" || simple.name === "where") &&
        simple.selectors!.some((inner) => compoundMentions(inner.compounds.at(-1)!, test))),
  );
}

function selectorMentionsShell(selector: ComplexSelector): boolean {
  const isShell = (simple: SimpleSelector) =>
    simple.kind === "class" && simple.name === SHELL_CLASS;
  return selector.compounds.some((compound) => compoundMentions(compound, isShell));
}

const isFieldControl = (simple: SimpleSelector) =>
  (simple.kind === "class" && simple.name === SELECT.trigger) ||
  (simple.kind === "type" && (simple.name === "input" || simple.name === "textarea"));
const isShellBody = (simple: SimpleSelector) =>
  simple.kind === "class" && (simple.name === SELECT.shell || simple.name === "input-shell");

function clearsBorder(rule: CssRule): boolean {
  return rule.declarations.some(
    ({ property, value }) =>
      /^border(?:-(?:top|right|bottom|left))?(?:-(?:width|style))?$/u.test(property) &&
      /^(?:0(?:px)?|none|hidden)$/u.test(value.trim()),
  );
}

function clearsRing(rule: CssRule): boolean {
  return rule.declarations.some(
    ({ property, value }) =>
      /^(?:outline(?:-(?:width|style))?|box-shadow)$/u.test(property) &&
      /^(?:0(?:px)?|none)$/u.test(value.trim()),
  );
}

function drawsBorder(rule: CssRule): boolean {
  return rule.declarations.some(
    ({ property, value }) =>
      /^border(?:-(?:top|right|bottom|left))?$/u.test(property) &&
      !/^(?:0(?:px)?|none|hidden)$/u.test(value.trim()),
  );
}

export function shellNamingViolations(sources: readonly CssSourceFile[]): string[] {
  const violations: string[] = [];
  for (const rule of parseCssRules(sources)) {
    for (const selector of rule.selectors) {
      const target = selector.compounds.at(-1)!;
      const where = `${rule.source}:${rule.line} ${selector.text}`;
      if (compoundMentions(target, isFieldControl) && !selectorMentionsShell(selector)) {
        if (clearsBorder(rule))
          violations.push(`${where}：清零了控件边框，却没点名 .${SHELL_CLASS} 外壳`);
        if (clearsRing(rule))
          violations.push(`${where}：关掉了控件焦点环，却没点名 .${SHELL_CLASS} 外壳`);
      }
      const isShell = (simple: SimpleSelector) =>
        simple.kind === "class" && simple.name === SHELL_CLASS;
      if (
        compoundMentions(target, isShellBody) &&
        drawsBorder(rule) &&
        !target.simples.some(isShell)
      ) {
        violations.push(`${where}：给外壳画了边框，却没点名 .${SHELL_CLASS}`);
      }
    }
  }
  return violations;
}

/* ─── 守卫三：同一张表单里的外壳取值一致（照抄旁边的输入框） ─── */

const SHELL_PROPERTIES = [
  "border-top-width",
  "border-top-style",
  "border-top-color",
  "border-radius",
  "background",
  "min-height",
  "outline-style",
  "outline-width",
  "outline-color",
  "outline-offset",
];
const RING_PROPERTIES = ["outline-style", "outline-width", "outline-color", "outline-offset"];

export function shellConsistencyViolations(sources: readonly CssSourceFile[]): string[] {
  const rules = parseCssRules(sources);
  const snapshot = (
    field: FieldCase,
    target: "shell" | "control",
    focused: boolean,
    environment: CascadeEnvironment,
    properties: readonly string[],
  ) => {
    const shell = querySelector(fieldDocument(), field.shell);
    const control = querySelector(shell, field.control);
    if (focused) focus(control, true);
    const style = cascade(rules, target === "shell" ? shell : control, environment);
    return Object.fromEntries(properties.map((name) => [name, style.get(name)?.value ?? null]));
  };
  const scenarios = [
    {
      label: "静止时的外壳",
      target: "shell",
      focused: false,
      environment: PHONE,
      properties: SHELL_PROPERTIES,
    },
    {
      label: "键盘聚焦时的外壳",
      target: "shell",
      focused: true,
      environment: PHONE,
      properties: SHELL_PROPERTIES,
    },
    {
      label: "forced-colors 下控件放回来的环",
      target: "control",
      focused: true,
      environment: PHONE_FORCED,
      properties: RING_PROPERTIES,
    },
  ] as const;
  const violations: string[] = [];
  for (const scenario of scenarios) {
    const [reference, ...others] = FIELD_CASES.map((field) => ({
      field,
      values: snapshot(
        field,
        scenario.target,
        scenario.focused,
        scenario.environment,
        scenario.properties,
      ),
    }));
    for (const other of others) {
      for (const name of scenario.properties) {
        if (other.values[name] !== reference!.values[name]) {
          violations.push(
            `${scenario.label}：${other.field.label}的 ${name} 是 ${other.values[name]}，${reference!.field.label}是 ${reference!.values[name]}`,
          );
        }
      }
    }
  }
  return violations;
}

/* ─── 守卫四：原生 select ─── */

export function nativeSelectOffenders(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([file, source]) => {
      // JSX 区分大小写：<Select 是自绘组件；HTML 不区分，<SELECT> 也是原生下拉。
      const tag = file.endsWith(".html") ? /<select(?=[\s>/])/iu : /<select(?=[\s>/])/u;
      return tag.test(source) || /createElement\(\s*["'`]select["'`]/u.test(source);
    })
    .map(([file]) => file);
}

/* ─── 变异工具：把根因写回真实 CSS，确认守卫真的会红 ─── */

function mutate(
  sources: readonly CssSourceFile[],
  file: string,
  from: string,
  to: string,
): CssSourceFile[] {
  let changed = false;
  const next = sources.map((source) => {
    if (!source.path.endsWith(file)) return source;
    const text = source.text.replace(from, to);
    changed ||= text !== source.text;
    return { ...source, text };
  });
  // 变异没落地，等于拿原样 CSS 去断言「会红」——这正是静态守卫空转的样子。
  if (!changed) throw new Error(`变异没有生效：${file} 里找不到\n${from}`);
  return next;
}

const TRIGGER_SUPPRESSOR = `.${SHELL_CLASS} > .${SELECT.trigger}:is(:hover, :focus, :focus-visible):not(:disabled) {`;
const TRIGGER_FORCED_RESTORE = `.${SELECT.shell}.${SHELL_CLASS} > .${SELECT.trigger}:focus-visible:not(:disabled) {`;
const INPUT_SUPPRESSOR = `.${SHELL_CLASS} :is(input, textarea):is(:focus, :focus-visible) {`;
const INPUT_FORCED_RESTORE = `.${SHELL_CLASS} :is(input, textarea):focus-visible {\n    outline: 2px solid Highlight;\n    outline-offset: -3px;\n  }`;
const SELECT_FOCUS_BORDER = `.${SELECT.shell}.${SHELL_CLASS}[data-open="true"],\n.${SELECT.shell}.${SHELL_CLASS}:has(:focus-visible) {`;

describe("手机端设计系统守卫", () => {
  it("样式图从 main.tsx 覆盖手机端全部 CSS，组件里不得私自引入样式", () => {
    const graph = readMobileCssGraph().map(relativeToRepository);
    const allMobileCss = recursiveFiles(mobileSourceRoot, ".css").map(relativeToRepository).sort();
    expect(graph[0]).toBe("packages/ui/src/tokens.css");
    expect(graph.filter((path) => path.startsWith("apps/mobile/")).sort()).toEqual(allMobileCss);
    expect(allMobileCss.length).toBeGreaterThanOrEqual(6);

    // 别的模块里引入的 CSS 不在 main.tsx 的 cascade 顺序里，守卫也就看不见它。
    const cssImport = /\bimport\b[^;]*?["'][^"']+\.css(?:\?[^"']*)?["']/u;
    const strays = mobileProductionSources()
      .filter((file) => file !== mobileEntry && cssImport.test(readFileSync(file, "utf8")))
      .map(relativeToRepository);
    expect(strays).toEqual([]);
    expect(cssImport.test('import "./x.css";')).toBe(true);
    expect(cssImport.test('import styles from "./x.module.css?inline";')).toBe(true);

    // 阳性对照：从入口删掉一条真实 import，图里就少了它。
    const entry = readFileSync(mobileEntry, "utf8");
    const withoutOverlays = entry.replace(/import "\.\/styles\/overlays\.css";\r?\n/u, "");
    expect(withoutOverlays).not.toBe(entry);
    expect(
      readMobileCssGraph(mobileEntry, withoutOverlays).map(relativeToRepository),
    ).not.toContain("apps/mobile/src/styles/overlays.css");
  });

  it("生产代码禁止原生 select（含 index.html、自闭合与 createElement 写法）", () => {
    const files = Object.fromEntries(
      mobileProductionSources().map((file) => [
        relativeToRepository(file),
        readFileSync(file, "utf8"),
      ]),
    );
    // 扫描面不能是空的，否则永远是绿的。
    expect(Object.keys(files).length).toBeGreaterThan(20);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "apps/mobile/index.html",
        "apps/mobile/src/ui/select.tsx",
        "apps/mobile/src/screens/new-task.tsx",
      ]),
    );
    expect(nativeSelectOffenders(files)).toEqual([]);

    const realTsx = files["apps/mobile/src/screens/new-task.tsx"]!;
    expect(realTsx).toContain("<Select");
    expect(
      nativeSelectOffenders({ "new-task.tsx": realTsx.replace("<Select", "<select") }),
    ).toEqual(["new-task.tsx"]);
    expect(
      nativeSelectOffenders({
        "a.tsx": "export const Bad = () => <select />;",
        "b.tsx": "<select/>",
        "c.ts": 'document.createElement("select");',
        "d.ts": "createElement('select', null)",
        "e.html": "<SELECT name=x></SELECT>",
        "ok-1.tsx": "<Select label='x' />",
        "ok-2.tsx": "const selected = <selection-list />;",
      }),
    ).toEqual(["a.tsx", "b.tsx", "c.ts", "d.ts", "e.html"]);
  });

  it("守卫模型取自真实组件 markup：生产代码里每种 field-shell 外壳都被模型覆盖", () => {
    const [root] = renderSelect();
    const trigger = querySelector(root!, '[role="combobox"]');
    expect(trigger.tag).toBe("button");
    // `.field-shell > .select-trigger` 依赖触发器是外壳的直接子元素。
    expect(trigger.parent).toBe(root);
    expect(classList(root!)).toContain(SHELL_CLASS);

    const selectSource = readFileSync(`${mobileSourceRoot}/ui/select.tsx`, "utf8");
    expect(selectSource).toContain('className="select-popover"');
    expect(selectSource).toContain('className="select-option"');

    // 生产 TSX 里出现过的每一种外壳组合，都必须能对上模型里的某个字段。
    const shells = new Set<string>();
    for (const file of mobileProductionSources().filter((path) => path.endsWith(".tsx"))) {
      for (const match of readFileSync(file, "utf8").matchAll(
        /className=(?:"([^"]*)"|\{`([^`]*)`\})/gu,
      )) {
        const classes = (match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/gu, " ").trim();
        if (classes.split(/\s+/u).includes(SHELL_CLASS)) shells.add(classes.replace(/\s+/gu, " "));
      }
    }
    expect(shells.size).toBeGreaterThanOrEqual(2);
    const document = fieldDocument();
    const uncovered = [...shells].filter((classes) => {
      const probe = element("div", { class: classes });
      appendChild(querySelector(document, "form"), probe);
      return !FIELD_CASES.some((field) => {
        try {
          return querySelector(probe, field.shell) === probe;
        } catch {
          return false;
        }
      });
    });
    expect(uncovered).toEqual([]);
  });

  it("一个字段只有外壳画环：键盘聚焦一圈、触摸聚焦按钮不留环、壳里其他按钮保留自己的环、forced-colors 下控件把环放回来", () => {
    expect(fieldFocusViolations(mobileCssSources())).toEqual([]);
  });

  it("forced-colors 出口靠特指度压住壳内压环规则，不依赖文件引入顺序", () => {
    const sources = mobileCssSources();
    expect(fieldFocusViolations([...sources].reverse())).toEqual([]);

    const rules = parseCssRules(sources);
    const specificityOf = (text: string) => {
      const rule = rules.find((candidate) => `${candidate.selectorText} {` === text);
      if (!rule) throw new Error(`找不到规则 ${text}`);
      return formatSpecificity(selectorSpecificity(rule.selectors[0]!));
    };
    expect(specificityOf(TRIGGER_SUPPRESSOR)).toBe("(0,4,0)");
    expect(specificityOf(TRIGGER_FORCED_RESTORE)).toBe("(0,5,0)");
  });

  it("清零控件边框、给外壳画边框的规则都点名了 field-shell 外壳", () => {
    expect(shellNamingViolations(mobileCssSources())).toEqual([]);
  });

  it("下拉外壳与输入框外壳取值一致：静止与聚焦的边框、圆角、底色、高度、焦点环，以及 forced-colors 下控件的环", () => {
    expect(shellConsistencyViolations(mobileCssSources())).toEqual([]);
  });

  describe("阳性对照：逐条把根因写回去，守卫必须变红", () => {
    const sources = mobileCssSources();

    it("输入框版：壳里的输入框重新画 box-shadow 环 / 不再关 outline", () => {
      const shadow = mutate(
        sources,
        "controls.css",
        `${INPUT_SUPPRESSOR}\n  outline: none;\n  box-shadow: none;`,
        `${INPUT_SUPPRESSOR}\n  outline: none;\n  box-shadow: 0 0 0 3px var(--atm-focus);`,
      );
      expect(fieldFocusViolations(shadow)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^单行输入框：键盘聚焦时控件自己画了 box-shadow/u),
          expect.stringMatching(/^多行输入框：键盘聚焦时控件自己画了 box-shadow/u),
        ]),
      );
      const outline = mutate(
        sources,
        "controls.css",
        `${INPUT_SUPPRESSOR}\n  outline: none;`,
        `${INPUT_SUPPRESSOR}`,
      );
      expect(fieldFocusViolations(outline)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^单行输入框：键盘聚焦时控件自己画了 outline/u),
        ]),
      );
    });

    it("按钮版：下拉触发器不再关 outline，或压环规则泛化成 button", () => {
      const outline = mutate(
        sources,
        "overlays.css",
        `${TRIGGER_SUPPRESSOR}\n  outline: none;`,
        TRIGGER_SUPPRESSOR,
      );
      expect(fieldFocusViolations(outline)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^下拉触发器：键盘聚焦时控件自己画了 outline/u),
        ]),
      );
      const generalised = mutate(
        sources,
        "overlays.css",
        TRIGGER_SUPPRESSOR,
        `.${SHELL_CLASS} button:is(:hover, :focus, :focus-visible):not(:disabled) {`,
      );
      expect(fieldFocusViolations(generalised)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^输入框壳里的辅助按钮：键盘聚焦时没有焦点环/u),
          expect.stringMatching(/^下拉弹层里的选项：键盘聚焦时没有焦点环/u),
        ]),
      );
    });

    it("外壳用 :focus-within 代替 :has(:focus-visible)：触摸点一下下拉就留一圈环", () => {
      const focusWithin = mutate(
        sources,
        "controls.css",
        `.${SHELL_CLASS}:has(:focus-visible) {`,
        `.${SHELL_CLASS}:focus-within {`,
      );
      expect(fieldFocusViolations(focusWithin)).toEqual([
        expect.stringMatching(/^下拉触发器：触摸聚焦（非 :focus-visible）时外壳也画了环/u),
      ]);
    });

    it("forced-colors 出口：删掉、或特指度降到与压环规则持平（文件又在前）都会红", () => {
      const removedTrigger = mutate(
        sources,
        "controls.css",
        TRIGGER_FORCED_RESTORE,
        ".unused-guard-probe {",
      );
      expect(fieldFocusViolations(removedTrigger)).toEqual([
        expect.stringMatching(/^下拉触发器：forced-colors 下控件没有用 Highlight 把焦点环放回来/u),
      ]);
      const weakTrigger = mutate(
        sources,
        "controls.css",
        TRIGGER_FORCED_RESTORE,
        `.${SHELL_CLASS} > .${SELECT.trigger}:focus-visible:not(:disabled) {`,
      );
      expect(fieldFocusViolations(weakTrigger)).toEqual([
        expect.stringMatching(/^下拉触发器：forced-colors 下控件没有用 Highlight 把焦点环放回来/u),
      ]);
      const removedInput = mutate(sources, "controls.css", INPUT_FORCED_RESTORE, "");
      expect(fieldFocusViolations(removedInput)).toEqual([
        expect.stringMatching(/^单行输入框：forced-colors 下控件没有用 Highlight/u),
        expect.stringMatching(/^多行输入框：forced-colors 下控件没有用 Highlight/u),
      ]);
    });

    it("边框：外壳边框不点名 field-shell、触发器清零边框不点名 field-shell、触发器干脆不清边框", () => {
      const shellBorder = mutate(
        sources,
        "overlays.css",
        `.${SELECT.shell}.${SHELL_CLASS} {`,
        `.${SELECT.shell} {`,
      );
      expect(shellNamingViolations(shellBorder)).toEqual([
        expect.stringMatching(
          /overlays\.css:\d+ \.select：给外壳画了边框，却没点名 \.field-shell$/u,
        ),
      ]);
      const triggerBorder = mutate(
        sources,
        "overlays.css",
        `.${SHELL_CLASS} > .${SELECT.trigger} {\n  border: 0;`,
        `.${SELECT.trigger} {\n  border: 0;`,
      );
      expect(shellNamingViolations(triggerBorder)).toEqual([
        expect.stringMatching(/\.select-trigger：清零了控件边框，却没点名 \.field-shell 外壳$/u),
      ]);
      const triggerRing = mutate(
        sources,
        "overlays.css",
        TRIGGER_SUPPRESSOR,
        `.${SELECT.trigger}:focus {`,
      );
      expect(shellNamingViolations(triggerRing)).toEqual([
        expect.stringMatching(
          /\.select-trigger:focus：关掉了控件焦点环，却没点名 \.field-shell 外壳$/u,
        ),
      ]);
      const noClear = mutate(
        sources,
        "overlays.css",
        `.${SHELL_CLASS} > .${SELECT.trigger} {\n  border: 0;\n}`,
        "",
      );
      expect(fieldFocusViolations(noClear)).toEqual([
        expect.stringMatching(/^下拉触发器：控件自己也画了边框/u),
      ]);
    });

    it("外壳取值：下拉聚焦不换主色边、forced-colors 下两种控件的环画在不同位置", () => {
      const focusBorder = mutate(
        sources,
        "overlays.css",
        SELECT_FOCUS_BORDER,
        `.${SELECT.shell}.${SHELL_CLASS}[data-open="true"] {`,
      );
      expect(shellConsistencyViolations(focusBorder)).toEqual([
        expect.stringMatching(/^键盘聚焦时的外壳：单行输入框的 border-top-color 是 color-mix/u),
        expect.stringMatching(/^键盘聚焦时的外壳：多行输入框的 border-top-color 是 color-mix/u),
      ]);
      const offset = mutate(
        sources,
        "controls.css",
        INPUT_FORCED_RESTORE,
        INPUT_FORCED_RESTORE.replace("outline-offset: -3px;", "outline-offset: 2px;"),
      );
      expect(shellConsistencyViolations(offset)).toEqual([
        "forced-colors 下控件放回来的环：单行输入框的 outline-offset 是 2px，下拉触发器是 -3px",
        "forced-colors 下控件放回来的环：多行输入框的 outline-offset 是 2px，下拉触发器是 -3px",
      ]);
    });

    it("模型本身：看不懂的语法直接报错，不静默放行", () => {
      expect(() =>
        parseCssRules([{ path: "x.css", text: ".a:checked-ish { color: red; }" }]),
      ).toThrow(/不认识伪类/u);
      expect(() =>
        parseCssRules([{ path: "x.css", text: "@layer base { .a { color: red; } }" }]),
      ).toThrow(/不认识 at-rule/u);
      expect(() =>
        fieldFocusViolations([
          ...sources,
          { path: "x.css", text: "@media (orientation: portrait) { .a { color: red; } }" },
        ]),
      ).toThrow(/不认识媒体特性/u);
    });
  });
});
