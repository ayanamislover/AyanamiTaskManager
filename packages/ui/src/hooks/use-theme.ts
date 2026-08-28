import { useEffect, useLayoutEffect, useState } from "react";
import type { Theme } from "../contracts.js";

const themeStorageKey = "atm.theme";

export function readStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(themeStorageKey);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function readSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function persistTheme(theme: Theme) {
  try {
    window.localStorage.setItem(themeStorageKey, theme);
  } catch {
    // 本地存储不可用时仍保留当前窗口的主题切换能力。
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? readSystemTheme());
  const [hasManualTheme, setHasManualTheme] = useState(() => readStoredTheme() !== null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.themeSwitching = "true";
    root.dataset.theme = theme;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => delete root.dataset.themeSwitching);
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      delete root.dataset.themeSwitching;
    };
  }, [theme]);
  useEffect(() => {
    if (hasManualTheme) return;
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = (event: MediaQueryListEvent) =>
      setTheme(event.matches ? "dark" : "light");
    preference.addEventListener("change", syncSystemTheme);
    return () => preference.removeEventListener("change", syncSystemTheme);
  }, [hasManualTheme]);
  const toggleTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    setHasManualTheme(true);
    setTheme(nextTheme);
    persistTheme(nextTheme);
  };
  return { theme, toggleTheme };
}
