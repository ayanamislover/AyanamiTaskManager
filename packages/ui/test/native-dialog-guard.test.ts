import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// 系统原生弹窗由操作系统绘制，和界面风格完全脱节；window.prompt 在 Electron 里更是
// 直接抛 "not supported"，靠它取输入的按钮在桌面端点了没有任何反应；Android WebView 里
// confirm/alert 弹的是系统对话框。这条守卫扫渲染层、主进程与手机端的生产代码，出现即红。
//
// 判断用 TypeScript 的语法树和作用域解析，不用正则：手机配对页有个本地函数也叫 confirm()，
// 正则分不清它和全局的 window.confirm；作用域解析能——本地声明过的不算，解析不到声明的才是全局。
// 注释和字符串里的字样也天然不会误报。

const roots = [
  join(process.cwd(), "packages", "ui", "src"),
  join(process.cwd(), "apps", "desktop", "src"),
  join(process.cwd(), "apps", "mobile", "src"),
];

const DIALOG_NAMES = new Set(["alert", "confirm", "prompt"]);
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self", "top", "parent"]);
const ELECTRON_DIALOGS = new Set(["showMessageBox", "showMessageBoxSync", "showErrorBox"]);

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function nativeDialogCalls(files: Record<string, string>): string[] {
  const sourceFiles = new Map(
    Object.entries(files).map(([file, source]) => [
      file,
      ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file)),
    ]),
  );
  // 只要作用域解析：不带标准库、不解析 import，全局的 confirm/window 因此一律「找不到声明」。
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    types: [],
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (file) => sourceFiles.get(file);
  host.fileExists = (file) => sourceFiles.has(file);
  host.readFile = (file) => files[file];
  const program = ts.createProgram({ rootNames: [...sourceFiles.keys()], options, host });
  const checker = program.getTypeChecker();

  /** 在本文件里声明过（局部变量、函数、参数、import）的标识符不是全局的那一个。 */
  const declaredInFile = (identifier: ts.Identifier) => {
    const symbol = checker.getSymbolAtLocation(identifier);
    const file = identifier.getSourceFile().fileName;
    return Boolean(symbol?.declarations?.some((node) => node.getSourceFile().fileName === file));
  };
  const isGlobalObject = (node: ts.Expression): node is ts.Identifier =>
    ts.isIdentifier(node) && GLOBAL_OBJECTS.has(node.text) && !declaredInFile(node);
  const memberName = (node: ts.Expression): string | null => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      return node.argumentExpression.text;
    }
    return null;
  };

  const hits: string[] = [];
  for (const [file, sourceFile] of sourceFiles) {
    const report = (node: ts.Node, label: string) => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      hits.push(`${file}:${line} ${label}: ${node.getText(sourceFile)}`);
    };
    const visit = (node: ts.Node): void => {
      // window.confirm / globalThis["alert"]：不只调用，取出来另存也算（const ask = window.confirm）。
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const name = memberName(node);
        if (name && DIALOG_NAMES.has(name) && isGlobalObject(node.expression)) {
          report(node, "window 原生弹窗");
        }
        if (name && ELECTRON_DIALOGS.has(name)) {
          const target = node.expression;
          const dialogObject =
            (ts.isIdentifier(target) && target.text === "dialog") ||
            (ts.isPropertyAccessExpression(target) && target.name.text === "dialog");
          if (dialogObject) report(node, "Electron 系统消息框");
        }
      }
      // 裸调用 confirm(...)：作用域里找不到声明，才是全局的那一个。
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        DIALOG_NAMES.has(node.expression.text) &&
        !declaredInFile(node.expression)
      ) {
        report(node.expression, "裸调用原生弹窗");
      }
      // const { confirm } = window：解构出来以后的调用会解析到本地绑定，所以在解构处抓。
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isGlobalObject(node.initializer)
      ) {
        for (const binding of node.name.elements) {
          const key = binding.propertyName ?? binding.name;
          if (ts.isIdentifier(key) && DIALOG_NAMES.has(key.text)) report(binding, "解构原生弹窗");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return hits;
}

function productionSources(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|tsx)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name))
        files[relative(process.cwd(), path).replaceAll("\\", "/")] = readFileSync(path, "utf8");
    }
  };
  for (const root of roots) walk(root);
  return files;
}

describe("原生弹窗守卫", () => {
  it("桌面渲染层、主进程与手机端的生产代码里没有 confirm / prompt / alert 与 Electron 系统消息框", () => {
    const sources = productionSources();
    // 扫描面不能是空的，否则永远是绿的。
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    for (const expected of [
      "packages/ui/src/features/task-drawer.tsx",
      "apps/desktop/src/core-main.ts",
      "apps/desktop/src/renderer.tsx",
      "apps/mobile/src/screens/pairing.tsx",
      "apps/mobile/src/app.tsx",
    ]) {
      expect(Object.keys(sources)).toContain(expected);
    }
    expect(nativeDialogCalls(sources)).toEqual([]);
  });

  it("手机配对页的本地 confirm() 不误报；去掉本地声明、或写进真正的 window.confirm，同一个文件就红", () => {
    const pairing = "apps/mobile/src/screens/pairing.tsx";
    const source = productionSources()[pairing]!;
    expect(source).toContain("const confirm = async () =>");
    expect(source).toContain("void confirm()");
    expect(nativeDialogCalls({ [pairing]: source })).toEqual([]);

    // 本地声明改名后，原来那句 confirm() 解析不到声明，就成了全局的 window.confirm。
    const unbound = source.replace(
      "const confirm = async () =>",
      "const confirmPairing = async () =>",
    );
    expect(nativeDialogCalls({ [pairing]: unbound })).toEqual([
      expect.stringMatching(
        /^apps\/mobile\/src\/screens\/pairing\.tsx:\d+ 裸调用原生弹窗: confirm$/u,
      ),
    ]);

    const probe = source.replace(
      "const confirm = async () => {",
      'const confirm = async () => {\n    if (!window.confirm("确认配对？")) return;',
    );
    expect(nativeDialogCalls({ [pairing]: probe })).toEqual([
      expect.stringMatching(/:\d+ window 原生弹窗: window\.confirm$/u),
    ]);
  });

  it("阳性对照：每种写法都会被抓到，本地同名函数、应用内对话框、注释与字符串不会误报", () => {
    const hits = nativeDialogCalls({
      "a.tsx": 'if (window.confirm("确定？")) run();',
      "b.tsx": "const name = window.prompt ( '名称' );",
      "c.tsx": 'if (confirm("裸调用")) run();',
      "d.tsx": 'globalThis.alert("x");',
      "e.ts": 'await dialog.showMessageBox(win, { message: "x" });',
      "f.ts": 'dialog.showErrorBox("标题", "内容");',
      "g.ts": 'const ask = window.confirm;\nask("另存后再调");',
      "h.ts": 'window["prompt"]("方括号");',
      "i.ts": 'const { confirm: ask } = window;\nask("解构");',
      "j.ts":
        'function inner() {\n  const confirm = () => true;\n  return confirm();\n}\nconfirm("外层");',
      "k.ts": 'electron.dialog.showMessageBoxSync({ message: "x" });',
    });
    expect(hits.map((hit) => hit.split(" ")[0])).toEqual([
      "a.tsx:1",
      "b.tsx:1",
      "c.tsx:1",
      "d.tsx:1",
      "e.ts:1",
      "f.ts:1",
      "g.ts:1",
      "h.ts:1",
      "i.ts:1",
      "j.ts:5",
      "k.ts:1",
    ]);

    expect(
      nativeDialogCalls({
        "ok.tsx": [
          "// 原来这里是 window.confirm(...)，Electron 不支持 prompt()",
          '/* window.prompt("旧写法") */',
          'const text = "window.confirm(";',
          'if (await dialogs.confirm({ title: "t", message: "m", confirmLabel: "c" })) run();',
          'const value = await useDialogs().prompt({ title: "t", label: "l", confirmLabel: "c" });',
        ].join("\n"),
        "local.tsx": [
          "const confirm = async () => true;",
          "function alert(message: string) { return message; }",
          'export const A = () => <button onClick={() => void confirm()}>{alert("x")}</button>;',
        ].join("\n"),
        "param.ts": "export function run(prompt: (q: string) => string) { return prompt('q'); }",
        "import.ts": 'import { confirm } from "./dialogs";\nawait confirm({ title: "t" });',
      }),
    ).toEqual([]);
  });
});
