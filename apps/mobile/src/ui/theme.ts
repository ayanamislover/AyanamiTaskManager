import { useSyncExternalStore } from "react";
import {
  AtmNative,
  NATIVE_EVENT,
  nativeInsets,
  nativeIsDark,
  type NativeEventDetail,
  type NativeInsets,
} from "../native/platform.js";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "atm-mobile-theme";
// 与 tokens.css 的 --atm-bg 一致：原生窗口底色（键盘弹起的过渡、横屏刘海边）用它，免得露出白边。
const BACKGROUND = { light: "#fbf7ff", dark: "#241e30" } as const;

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

let preference: ThemePreference = readPreference();
let systemDark =
  nativeIsDark() ?? window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
const listeners = new Set<() => void>();

export function resolvedTheme(): "light" | "dark" {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

function apply(): void {
  const theme = resolvedTheme();
  const root = document.documentElement;
  if (root.dataset.theme !== theme) {
    // 切换瞬间关掉过渡，免得每个元素各自慢慢变色（与桌面端同一做法）。
    root.dataset.themeSwitching = "true";
    root.dataset.theme = theme;
    requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.themeSwitching));
  }
  void AtmNative.setSystemBars({ dark: theme === "dark", background: BACKGROUND[theme] }).catch(
    () => undefined,
  );
  for (const listener of listeners) listener();
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 存不下只影响下次启动。
  }
  apply();
}

function applyInsets(insets: NativeInsets | null): void {
  if (!insets) return;
  const style = document.documentElement.style;
  style.setProperty("--inset-top", `${insets.top}px`);
  style.setProperty("--inset-bottom", `${insets.bottom}px`);
}

/** 启动时调用一次：接上原生的主题与系统栏事件；浏览器开发时退回 matchMedia。 */
export function installTheme(): void {
  applyInsets(nativeInsets());
  window.addEventListener(NATIVE_EVENT, (event) => {
    const detail = (event as CustomEvent<NativeEventDetail>).detail ?? {};
    if (detail.insets) applyInsets(detail.insets);
    if (typeof detail.dark === "boolean" && detail.dark !== systemDark) {
      systemDark = detail.dark;
      apply();
    }
  });
  if (nativeIsDark() === null) {
    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
      systemDark = event.matches;
      apply();
    });
  }
  apply();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference);
}

export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, resolvedTheme);
}
