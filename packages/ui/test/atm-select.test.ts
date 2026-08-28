import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AtmSelect } from "../src/components/atm-select.js";

const sourcePath = join(process.cwd(), "packages", "ui", "src", "components", "atm-select.tsx");

const keyboardContracts = {
  modality: /event\.detail === 0 \? "keyboard" : "pointer"/u,
  triggerDown: /event\.key === "ArrowDown"[\s\S]*?openAt\(selectedIndex, "keyboard"\)/u,
  triggerUp: /event\.key === "ArrowUp"[\s\S]*?openAt\([\s\S]*?, "keyboard"\)/u,
  optionDown: /event\.key === "ArrowDown"[\s\S]*?focusOption\(index \+ 1\)/u,
  optionUp: /event\.key === "ArrowUp"[\s\S]*?focusOption\(index - 1\)/u,
  home: /event\.key === "Home"[\s\S]*?focusOption\(0\)/u,
  end: /event\.key === "End"[\s\S]*?focusOption\(options\.length - 1\)/u,
  triggerEscape:
    /aria-haspopup="listbox"[\s\S]*?onKeyDown=[\s\S]*?event\.key === "Escape" && openPhaseRef\.current[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?closeAndFocusTrigger\(\)/u,
  optionEscape:
    /else if \(event\.key === "Escape" && openPhaseRef\.current\) \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*closeAndFocusTrigger\(\);\s*\} else if \(event\.key === "Tab"\)/u,
  tab: /event\.key === "Tab"[\s\S]*?openPhaseRef\.current = false[\s\S]*?setOpen\(false\)/u,
  wrap: /\(index \+ options\.length\) % options\.length/u,
  focusReturn: /requestAnimationFrame\(\(\) => triggerRef\.current\?\.focus\(\)\)/u,
  synchronousOpenPhase:
    /openPhaseRef\.current = true;\s*setOpen\(true\)[\s\S]*?openPhaseRef\.current = false;\s*setOpen\(false\)/u,
} as const;

function missingKeyboardContracts(source: string): string[] {
  return Object.entries(keyboardContracts)
    .filter(([, pattern]) => !pattern.test(source))
    .map(([name]) => name);
}

describe("AtmSelect", () => {
  it("保持初始 DOM、class、aria 与 data 属性", () => {
    const markup = renderToStaticMarkup(
      createElement(AtmSelect, {
        id: "status-filter",
        ariaLabel: "状态筛选",
        value: "READY",
        options: [
          { value: "ALL", label: "全部状态" },
          { value: "READY", label: "就绪" },
        ],
        onChange: () => undefined,
        className: "wide",
      }),
    );

    expect(markup).toMatch(
      /^<div class="atm-select atm-field-shell wide" data-open="false" data-open-input="pointer" data-placement="bottom">/u,
    );
    expect(markup).toContain(
      'id="status-filter" type="button" class="atm-select-trigger" role="combobox" aria-label="状态筛选"',
    );
    expect(markup).toMatch(/aria-controls="atm-select-[^"]+" aria-expanded="false"/u);
    expect(markup).toContain('aria-haspopup="listbox"><span>就绪</span>');
    expect(markup).not.toContain("atm-select-popover");
  });

  it("保持空选项回退文案", () => {
    const markup = renderToStaticMarkup(
      createElement(AtmSelect, {
        ariaLabel: "空选项",
        value: "",
        options: [],
        onChange: () => undefined,
      }),
    );
    expect(markup).toContain("<span>未选择</span>");
  });

  it("组件实现保留完整键盘、modality、wrap 与焦点返回契约", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(missingKeyboardContracts(source)).toEqual([]);

    for (const [name, pattern] of Object.entries(keyboardContracts)) {
      expect(
        missingKeyboardContracts(source.replace(pattern, "/* removed by positive fixture */")),
      ).toContain(name);
    }
  });

  it("选项进入退出动效后不再吞掉属于外层 Dialog 的 Escape", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toMatch(
      /else if \(event\.key === "Escape" && openPhaseRef\.current\)[\s\S]*?event\.stopPropagation\(\)/u,
    );
    expect(source).not.toMatch(/else if \(event\.key === "Escape"\) \{\s*event\.preventDefault/u);
  });

  it("保持弹层定位、首次焦点与外部点击关闭算法", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toMatch(/root\.closest\("\.atm-modal, \.atm-drawer"\)/u);
    expect(source).toMatch(/Math\.min\(320, options\.length \* 34 \+ 12\)/u);
    expect(source).toMatch(/spaceBelow < desired && spaceAbove > spaceBelow \? "top" : "bottom"/u);
    expect(source).toMatch(/optionRefs\.current\[openingIndexRef\.current\]\?\.focus\(\)/u);
    expect(source).toMatch(/addEventListener\("pointerdown", handleOutsidePress, true\)/u);
    expect(source).toMatch(/removeEventListener\("pointerdown", handleOutsidePress, true\)/u);
  });
});
