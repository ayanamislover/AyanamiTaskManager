/**
 * 顶栏、顶沿拖动区与 Windows 10 外框的源码守卫。原生层面的实测（命中、屏幕像素）在
 * scripts/window-smoke.ts；这里守住那几处根因不被写回去，每条都配阳性对照：把根因写回去必须变红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (...path: string[]) => readFileSync(join(root, ...path), "utf8");
const shellCss = read("packages", "ui", "src", "styles", "shell.css");
const chromeCss = read("apps", "desktop", "src", "window-chrome.css");
const appShell = read("packages", "ui", "src", "shell", "app-shell.tsx");
const renderer = read("apps", "desktop", "src", "renderer.tsx");
const hostApp = read("apps", "desktop", "native", "host", "src", "app.rs");

/** 选择器恰好是 selector 的那些规则体（不含 @media 里的同名规则以外的东西）。 */
function rules(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...css.matchAll(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, "gu"))].map(
    (match) => match[1] ?? "",
  );
}

function appRegion(css: string, selector: string): string | null {
  const values = rules(css, selector)
    .map((body) => /-webkit-app-region:\s*([\w-]+)/u.exec(body)?.[1])
    .filter((value): value is string => value !== undefined);
  return values.at(-1) ?? null;
}

/** 问题 1：顶栏的磨砂底停在顶部时必须透明（滚动时间线驱动，滚不动时也是 0）。 */
function topbarVeilProblems(css: string): string[] {
  const problems: string[] = [];
  const block = /@supports \(animation-timeline: scroll\(\)\) \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  if (!block) return ["没有按滚动时间线控制顶栏磨砂底"];
  const veil = /\.atm-topbar::before\s*\{([^}]*)\}/u.exec(block)?.[1] ?? "";
  if (!/(^|\s)opacity:\s*0;/u.test(veil)) problems.push("滚不动时磨砂底不是透明的");
  if (!/animation:\s*atm-topbar-veil\b/u.test(veil)) problems.push("磨砂底没挂渐显动画");
  if (!/animation-timeline:\s*scroll\(nearest block\)/u.test(veil))
    problems.push("渐显不跟主区域的滚动走");
  if (!/animation-range:\s*0 \d+px/u.test(veil)) problems.push("渐显不是从滚动 0 开始");
  // 动画写在时间线前面：shorthand 会把 animation-timeline 重置回 auto（按时间播一遍就停在 1）。
  if (veil.indexOf("animation:") > veil.indexOf("animation-timeline:"))
    problems.push("animation 简写写在 animation-timeline 后面，会把时间线冲掉");
  const from = /@keyframes atm-topbar-veil\s*\{\s*from\s*\{([^}]*)\}/u.exec(css)?.[1] ?? "";
  if (!/opacity:\s*0;/u.test(from)) problems.push("渐显动画的起点不是透明");
  return problems;
}

/** 问题 2：顶沿整条是拖动区，且不把窗口按钮、顶栏里的控件吞成拖动区。 */
function dragRegionProblems(css: string, shell: string, markup: string, tsx: string): string[] {
  const desktop = (selector: string) => `html[data-atm-desktop="true"] ${selector}`;
  const problems: string[] = [];
  if (appRegion(css, desktop(".atm-shell")) !== "drag") problems.push("外壳四周的气口不是拖动区");
  if (appRegion(css, desktop(".atm-main")) !== "no-drag") problems.push("主区域没有退出拖动区");
  if (appRegion(css, desktop(".atm-titlebar-edge")) !== "drag")
    problems.push("顶栏上内边距那一条不是拖动区");
  // WebView2 按文档顺序判拖动区：顶栏整块 drag 会盖掉排在前面的窗口按钮。
  if (appRegion(css, desktop(".atm-topbar")) !== "no-drag")
    problems.push("顶栏整块声明成了拖动区，会吞掉窗口按钮");
  if (
    !/:is\(\.atm-modal, \.atm-drawer, \.atm-notice\)\s*\{\s*-webkit-app-region: no-drag;/u.test(css)
  )
    problems.push("浮在拖动区上的面板没有声明 no-drag");
  const edge = rules(shell, ".atm-titlebar-edge")[0] ?? "";
  const edgeHeight = /height:\s*(\d+)px/u.exec(edge)?.[1];
  const topbar = rules(shell, ".atm-topbar")[0] ?? "";
  const paddingTop = /padding:\s*(\d+)px/u.exec(topbar)?.[1];
  if (!edgeHeight || edgeHeight !== paddingTop)
    problems.push(`顶沿那一条高 ${edgeHeight}px，顶栏上内边距 ${paddingTop}px`);
  if (!/inset:\s*0 0 auto;/u.test(edge)) problems.push("顶沿那一条没贴着顶栏上沿");
  if (!/pointer-events:\s*none;/u.test(edge)) problems.push("顶沿那一条会挡住网页版的点击");
  if (
    !/<header className="atm-topbar">\s*<div className="atm-titlebar-edge" aria-hidden="true" \/>/u.test(
      markup,
    )
  )
    problems.push("顶栏里没有顶沿那一条");
  // 缩放把手排在整个界面后面（同样是文档顺序）：排在前面会被外壳的拖动区盖掉。
  const app = tsx.indexOf("<AyanamiTaskManager");
  const edges = tsx.indexOf("<DesktopWindowEdges");
  if (app < 0 || edges < app) problems.push("缩放把手没排在界面后面");
  return problems;
}

/** 问题 3：Windows 10 上不用 tao 的阴影模式（它留的非客户区让 DWM 画边框线）。 */
function frameProblems(rust: string, css: string): string[] {
  const problems: string[] = [];
  if (!rust.includes(".with_undecorated_shadow(!crate::frame::client_frame())"))
    problems.push("Windows 10 仍按阴影模式建窗口（左、右、下会有 DWM 边框线）");
  if (!rust.includes("crate::frame::install(window.hwnd());")) problems.push("没把阴影找回来");
  const edge = rules(css, ".atm-window-edge")[0] ?? "";
  if (!/-webkit-app-region:\s*no-drag;/u.test(edge)) problems.push("缩放把手没声明 no-drag");
  const handle = Number(/z-index:\s*(\d+)/u.exec(edge)?.[1] ?? 0);
  const chrome = Math.max(
    0,
    ...rules(css, ".atm-window-chrome").map((body) =>
      Number(/z-index:\s*(\d+)/u.exec(body)?.[1] ?? 0),
    ),
  );
  if (!(handle > chrome)) problems.push("缩放把手压在窗口按钮下面");
  return problems;
}

describe("顶栏与彩雾是一体的", () => {
  it("磨砂底停在顶部时透明，滚动后才浮出来", () => {
    expect(topbarVeilProblems(shellCss)).toEqual([]);
  });

  it("阳性对照：把常显的磨砂底写回去就变红", () => {
    const always = shellCss.replace(
      /@supports \(animation-timeline: scroll\(\)\) \{[\s\S]*?\n\}\n/u,
      "",
    );
    expect(always).not.toBe(shellCss);
    expect(topbarVeilProblems(always)).toContain("没有按滚动时间线控制顶栏磨砂底");
    const inactive = shellCss.replace(
      /(@supports[^{]*\{\s*\.atm-topbar::before \{\s*)opacity: 0;\s*/u,
      "$1",
    );
    expect(topbarVeilProblems(inactive)).toContain("滚不动时磨砂底不是透明的");
    const opaqueStart = shellCss.replace(
      /(@keyframes atm-topbar-veil\s*\{\s*from\s*\{\s*)opacity: 0;/u,
      "$1opacity: 1;",
    );
    expect(topbarVeilProblems(opaqueStart)).toContain("渐显动画的起点不是透明");
    const reordered = shellCss.replace(
      /(animation: atm-topbar-veil linear both;)\s*(animation-timeline: scroll\(nearest block\);)/u,
      "$2\n    $1",
    );
    expect(topbarVeilProblems(reordered)).toContain(
      "animation 简写写在 animation-timeline 后面，会把时间线冲掉",
    );
  });
});

describe("顶沿整条都能拖窗口", () => {
  it("外壳气口与顶栏上内边距是拖动区，主区域、顶栏本身与浮层面板不是", () => {
    expect(dragRegionProblems(chromeCss, shellCss, appShell, renderer)).toEqual([]);
  });

  it("阳性对照：把各处根因写回去就变红", () => {
    const check = (css: string, shell = shellCss, markup = appShell, tsx = renderer) =>
      dragRegionProblems(css, shell, markup, tsx);
    const noEdge = chromeCss.replace(
      /(\.atm-titlebar-edge \{\s*)-webkit-app-region: drag;/u,
      "$1-webkit-app-region: no-drag;",
    );
    expect(check(noEdge)).toContain("顶栏上内边距那一条不是拖动区");
    const noShell = chromeCss.replace(
      /(\] \.atm-shell \{\s*)-webkit-app-region: drag;/u,
      "$1-webkit-app-region: none;",
    );
    expect(check(noShell)).toContain("外壳四周的气口不是拖动区");
    const wholeTopbar = chromeCss.replace(
      /(\] \.atm-topbar \{[^}]*)-webkit-app-region: no-drag;/u,
      "$1-webkit-app-region: drag;",
    );
    expect(check(wholeTopbar)).toContain("顶栏整块声明成了拖动区，会吞掉窗口按钮");
    const panels = chromeCss.replace(
      /:is\(\.atm-modal, \.atm-drawer, \.atm-notice\)/u,
      ".atm-nothing",
    );
    expect(check(panels)).toContain("浮在拖动区上的面板没有声明 no-drag");
    const shorter = shellCss.replace(/(\.atm-titlebar-edge \{[^}]*height: )18px/u, "$112px");
    expect(check(chromeCss, shorter)).toEqual([expect.stringContaining("顶沿那一条高 12px")]);
    const missing = appShell.replace(
      '<div className="atm-titlebar-edge" aria-hidden="true" />',
      "",
    );
    expect(check(chromeCss, shellCss, missing)).toContain("顶栏里没有顶沿那一条");
    const edgesFirst = renderer
      .replace("    {desktop ? <DesktopWindowEdges desktop={desktop} /> : null}\n", "")
      .replace(
        "    {desktop ? <DesktopWindowChrome desktop={desktop} /> : null}\n",
        "    {desktop ? <DesktopWindowChrome desktop={desktop} /> : null}\n    {desktop ? <DesktopWindowEdges desktop={desktop} /> : null}\n",
      );
    expect(edgesFirst).not.toBe(renderer);
    expect(check(chromeCss, shellCss, appShell, edgesFirst)).toContain("缩放把手没排在界面后面");
  });
});

describe("Windows 10 的外框不画边框线", () => {
  it("不用阴影模式、阴影另找回来，缩放把手接得住按下", () => {
    expect(frameProblems(hostApp, chromeCss)).toEqual([]);
  });

  it("阳性对照：把阴影模式写回去就变红", () => {
    const shadow = hostApp.replace(
      ".with_undecorated_shadow(!crate::frame::client_frame())",
      ".with_undecorated_shadow(true)",
    );
    expect(frameProblems(shadow, chromeCss)).toContain(
      "Windows 10 仍按阴影模式建窗口（左、右、下会有 DWM 边框线）",
    );
    const dragHandles = chromeCss.replace(
      /(\.atm-window-edge \{[^}]*)-webkit-app-region: no-drag;/u,
      "$1-webkit-app-region: drag;",
    );
    expect(frameProblems(hostApp, dragHandles)).toContain("缩放把手没声明 no-drag");
    const under = chromeCss.replace(/(\.atm-window-edge \{[^}]*z-index: )110;/u, "$190;");
    expect(frameProblems(hostApp, under)).toContain("缩放把手压在窗口按钮下面");
  });
});
