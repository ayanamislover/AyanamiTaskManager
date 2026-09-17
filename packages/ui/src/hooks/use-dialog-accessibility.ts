import { useLayoutEffect, useRef } from "react";

// 对话框可以叠放（抽屉或数据工具上再弹确认框）。键盘监听都挂在 document 上，
// 先注册的先执行，所以不能靠 preventDefault 让下层让路：只有栈顶那一层处理 Esc 和 Tab，
// 否则一次 Esc 会把确认框和它下面的抽屉一起关掉。
const openDialogs: symbol[] = [];

export function useDialogAccessibility(close: () => void, active = true) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    if (!active) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusableSelector =
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";
    const frame = window.requestAnimationFrame(() => {
      const preferred = dialog?.querySelector<HTMLElement>("[data-dialog-autofocus]");
      if (preferred) preferred.focus();
      else if (!dialog?.contains(document.activeElement))
        dialog?.querySelector<HTMLElement>(focusableSelector)?.focus();
    });
    const layer = Symbol("dialog");
    openDialogs.push(layer);
    const handleKey = (event: KeyboardEvent) => {
      if (openDialogs.at(-1) !== layer) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (element) => !element.hidden && element.getClientRects().length > 0,
      );
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      openDialogs.splice(openDialogs.indexOf(layer), 1);
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active]);
  return dialogRef;
}
