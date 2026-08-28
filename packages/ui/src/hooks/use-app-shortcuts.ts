import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { Route } from "../contracts.js";

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
    Boolean(target.closest('[contenteditable="true"]'))
  );
}

export function hasActiveDialog(root: ParentNode = document): boolean {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"]')].some(
    (dialog) => !dialog.closest('[inert], [aria-hidden="true"]'),
  );
}

export function useAppShortcuts(
  route: Route,
  setRoute: Dispatch<SetStateAction<Route>>,
  setPalette: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.ctrlKey || event.metaKey) ||
        isEditableTarget(event.target) ||
        hasActiveDialog()
      )
        return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette(true);
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (route.startsWith("project:")) window.dispatchEvent(new Event("atm:new-project-task"));
        else setRoute("quick");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route]);
}
