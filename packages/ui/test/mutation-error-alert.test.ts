import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MutationErrorAlert } from "../src/components/async-state.js";

const sourceRoot = join(process.cwd(), "packages", "ui", "src");

function productionTsx(directory = sourceRoot): Array<{ path: string; source: string }> {
  const files: Array<{ path: string; source: string }> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionTsx(path));
    else if (entry.name.endsWith(".tsx")) {
      files.push({
        path: relative(sourceRoot, path).replaceAll("\\", "/"),
        source: readFileSync(path, "utf8"),
      });
    }
  }
  return files;
}

function mutationNames(source: string): string[] {
  return [...source.matchAll(/const\s+(\w+)\s*=\s*useMutation\(/gu)].map((match) => match[1]!);
}

function uncoveredMutations(source: string): string[] {
  const names = mutationNames(source);
  if (!names.length) return [];
  if (!source.includes("<MutationErrorAlert")) return names;
  return names.filter((name) => !source.includes(`${name}.error`));
}

describe("MutationErrorAlert", () => {
  it("统一以 assertive alert 播报第一个异步写入错误", () => {
    const markup = renderToStaticMarkup(
      createElement(MutationErrorAlert, {
        errors: [null, new Error("保存失败"), new Error("后续错误")],
        prefix: "操作失败：",
      }),
    );
    expect(markup).toContain('class="atm-inline-error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("操作失败：保存失败");
    expect(markup).not.toContain("后续错误");

    const bounded = renderToStaticMarkup(
      createElement(MutationErrorAlert, { error: new Error("x".repeat(700)) }),
    );
    expect(bounded).toContain(`${"x".repeat(499)}…`);
    expect(bounded).not.toContain("x".repeat(500));
  });

  it("递归覆盖所有 production useMutation，且不再手写 mutation 错误框", () => {
    const mutationFiles = productionTsx().filter((file) => mutationNames(file.source).length);
    expect(mutationFiles.length).toBeGreaterThanOrEqual(10);
    for (const file of mutationFiles) {
      expect(uncoveredMutations(file.source), file.path).toEqual([]);
      for (const name of new Set(mutationNames(file.source))) {
        const declarations = mutationNames(file.source).filter((candidate) => candidate === name);
        const errorReferences = file.source.match(new RegExp(`\\b${name}\\.error\\b`, "gu")) ?? [];
        expect(errorReferences.length, `${file.path}:${name} duplicate or missing alert`).toBe(
          declarations.length,
        );
      }
      expect(file.source, file.path).not.toMatch(
        /<div[^>]*atm-inline-error[^>]*>[\s\S]{0,240}\b\w+\.error\b/u,
      );
    }
  });

  it("守卫对缺 alert 原语与漏掉任一 mutation error 的坏实现验红", () => {
    const missingPrimitive = "const save = useMutation({ mutationFn: write });";
    expect(uncoveredMutations(missingPrimitive)).toEqual(["save"]);

    const missingSecond = `
      const save = useMutation({ mutationFn: write });
      const remove = useMutation({ mutationFn: erase });
      return <MutationErrorAlert error={save.error} />;
    `;
    expect(uncoveredMutations(missingSecond)).toEqual(["remove"]);
  });
});
