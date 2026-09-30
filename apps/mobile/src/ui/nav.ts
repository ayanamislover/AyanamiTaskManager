import { useEffect, useSyncExternalStore } from "react";

/**
 * 页面栈。手机上的「返回」有三个来源：页面左上角的返回按钮、系统返回键 / 手势、
 * 以及弹层（下拉列表、确认框）自己的关闭。三者走同一个出口 handleBack()：
 * 先让最上层的弹层关闭，再出栈，栈底时返回 false 由调用方退出 App。
 */
export type Route =
  | { name: "overview" }
  | { name: "project"; code: string }
  | { name: "task"; code: string; key: string }
  | { name: "new"; code?: string }
  | { name: "settings" };

type NavState = { stack: Route[]; direction: "forward" | "back" | "none" };

let state: NavState = { stack: [{ name: "overview" }], direction: "none" };
const listeners = new Set<() => void>();
const backHandlers: Array<() => boolean> = [];

function set(next: NavState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function push(route: Route): void {
  set({ stack: [...state.stack, route], direction: "forward" });
}

export function pop(): boolean {
  if (state.stack.length <= 1) return false;
  set({ stack: state.stack.slice(0, -1), direction: "back" });
  return true;
}

/** 替换栈顶（例如新任务发出后直接换成总览，而不是叠在新任务页上）。 */
export function replaceTop(route: Route): void {
  set({ stack: [...state.stack.slice(0, -1), route], direction: "back" });
}

export function resetTo(route: Route): void {
  set({ stack: [route], direction: "none" });
}

export function handleBack(): boolean {
  for (let index = backHandlers.length - 1; index >= 0; index -= 1) {
    if (backHandlers[index]?.()) return true;
  }
  return pop();
}

/** 弹层打开期间挂一个返回处理：系统返回键先关它。 */
export function useBackHandler(active: boolean, onBack: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handler = () => {
      onBack();
      return true;
    };
    backHandlers.push(handler);
    return () => {
      const index = backHandlers.lastIndexOf(handler);
      if (index >= 0) backHandlers.splice(index, 1);
    };
  }, [active, onBack]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNav(): NavState {
  return useSyncExternalStore(subscribe, () => state);
}
