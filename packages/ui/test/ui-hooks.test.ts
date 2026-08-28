import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistTheme, readStoredTheme, readSystemTheme } from "../src/hooks/use-theme.js";

const hooksRoot = join(process.cwd(), "packages", "ui", "src", "hooks");

const hookContracts = {
  "dialog-accessibility": {
    closeRef: /const closeRef = useRef\(close\);\s*closeRef\.current = close;/u,
    previousFocus:
      /document\.activeElement instanceof HTMLElement \? document\.activeElement : null/u,
    autofocus: /querySelector<HTMLElement>\("\[data-dialog-autofocus\]"\)/u,
    fallbackFocus:
      /!dialog\?\.contains\(document\.activeElement\)[\s\S]*?querySelector<HTMLElement>\(focusableSelector\)\?\.focus\(\)/u,
    escape: /event\.key === "Escape"[\s\S]*?closeRef\.current\(\)/u,
    tabTrap: /event\.key !== "Tab" \|\| !dialog/u,
    visibleFocusable: /!element\.hidden && element\.getClientRects\(\)\.length > 0/u,
    emptyFocus: /!focusable\.length[\s\S]*?dialog\.focus\(\)/u,
    backwardsWrap: /event\.shiftKey && document\.activeElement === first[\s\S]*?last\.focus\(\)/u,
    forwardsWrap: /!event\.shiftKey && document\.activeElement === last[\s\S]*?first\.focus\(\)/u,
    cleanup:
      /cancelAnimationFrame\(frame\)[\s\S]*?removeEventListener\("keydown", handleKey\)[\s\S]*?previousFocus\?\.isConnected/u,
  },
  theme: {
    storageKey: /const themeStorageKey = "atm\.theme"/u,
    initialState: /useState<Theme>\(\(\) => readStoredTheme\(\) \?\? readSystemTheme\(\)\)/u,
    manualState: /useState\(\(\) => readStoredTheme\(\) !== null\)/u,
    switching: /root\.dataset\.themeSwitching = "true";\s*root\.dataset\.theme = theme;/u,
    doubleFrame:
      /const firstFrame = window\.requestAnimationFrame\(\(\) => \{\s*secondFrame = window\.requestAnimationFrame\(\(\) => delete root\.dataset\.themeSwitching\);/u,
    frameCleanup:
      /cancelAnimationFrame\(firstFrame\)[\s\S]*?cancelAnimationFrame\(secondFrame\)[\s\S]*?delete root\.dataset\.themeSwitching/u,
    systemMedia: /const preference = window\.matchMedia\("\(prefers-color-scheme: dark\)"\)/u,
    systemListener:
      /addEventListener\("change", syncSystemTheme\)[\s\S]*?removeEventListener\("change", syncSystemTheme\)/u,
    toggle:
      /const toggleTheme = \(\) => \{[\s\S]*?setHasManualTheme\(true\);[\s\S]*?setTheme\(nextTheme\);[\s\S]*?persistTheme\(nextTheme\);/u,
  },
  notice: {
    state: /const \[notice, setNotice\] = useState\(""\)/u,
    timer: /useRef<number \| null>\(null\)/u,
    notify:
      /const notify = \(message: string\) => \{\s*setNotice\(message\);\s*restartNoticeTimer\(noticeTimerRef, \(\) => setNotice\(""\)\);/u,
    cleanup: /useEffect\(\(\) => \(\) => cancelNoticeTimer\(noticeTimerRef\), \[\]\)/u,
  },
} as const;

function missingContracts(source: string, contracts: Record<string, RegExp>): string[] {
  return Object.entries(contracts)
    .filter(([, pattern]) => !pattern.test(source))
    .map(([name]) => name);
}

describe("UI hooks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("保持 theme storage/system helpers 的兼容与失败回退", () => {
    const getItem = vi.fn(() => "dark");
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: { getItem, setItem },
      matchMedia: vi.fn(() => ({ matches: false })),
    });

    expect(readStoredTheme()).toBe("dark");
    expect(readSystemTheme()).toBe("light");
    persistTheme("light");
    expect(getItem).toHaveBeenCalledWith("atm.theme");
    expect(setItem).toHaveBeenCalledWith("atm.theme", "light");

    getItem.mockReturnValue("unsupported");
    expect(readStoredTheme()).toBeNull();
  });

  it("storage 不可用时读写均不抛错", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
      matchMedia: () => ({ matches: true }),
    });
    expect(readStoredTheme()).toBeNull();
    expect(() => persistTheme("dark")).not.toThrow();
    expect(readSystemTheme()).toBe("dark");
  });

  it("dialog/theme/notice 源实现逐项保留生命周期契约并能验红", () => {
    for (const [hook, contracts] of Object.entries(hookContracts)) {
      const source = readFileSync(join(hooksRoot, `use-${hook}.ts`), "utf8");
      expect(source).not.toContain("useCallback");
      expect(missingContracts(source, contracts)).toEqual([]);
      for (const [name, pattern] of Object.entries(contracts)) {
        expect(
          missingContracts(source.replace(pattern, "/* positive mutation */"), contracts),
        ).toContain(name);
      }
    }
  });
});
