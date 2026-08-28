import type { KeyboardEvent, KeyboardEventHandler, MouseEventHandler } from "react";

export function nextRovingIndex(
  key: string,
  current: number,
  count: number,
  vertical = false,
): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight" || (vertical && key === "ArrowDown")) return (current + 1) % count;
  if (key === "ArrowLeft" || (vertical && key === "ArrowUp")) return (current - 1 + count) % count;
  return null;
}

export function moveRovingFocus(
  event: KeyboardEvent<HTMLElement>,
  options: {
    selector: string;
    index: number;
    count: number;
    vertical?: boolean;
    onMove: (index: number) => void;
  },
): void {
  const next = nextRovingIndex(event.key, options.index, options.count, options.vertical ?? false);
  if (next === null) return;
  event.preventDefault();
  const items = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(options.selector);
  options.onMove(next);
  items?.[next]?.focus();
}

export function taskRowInteractionProps(
  label: string,
  onOpen: () => void,
): {
  tabIndex: 0;
  "aria-label": string;
  "aria-haspopup": "dialog";
  onClick: MouseEventHandler<HTMLTableRowElement>;
  onKeyDown: KeyboardEventHandler<HTMLTableRowElement>;
} {
  const open = (target: HTMLTableRowElement) => {
    target.focus();
    onOpen();
  };
  return {
    tabIndex: 0,
    "aria-label": label,
    "aria-haspopup": "dialog",
    onClick: (event) => open(event.currentTarget),
    onKeyDown: (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open(event.currentTarget);
    },
  };
}
