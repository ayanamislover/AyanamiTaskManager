import {
  cloneElement,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactElement,
  type TransitionEvent,
} from "react";

export type PresencePhase = "unmounted" | "open" | "closing";
export type PresenceRootProps = Pick<
  HTMLAttributes<HTMLDivElement>,
  "aria-hidden" | "inert" | "onTransitionEnd"
> & {
  "data-presence"?: Exclude<PresencePhase, "unmounted">;
};

export function createPresenceLifecycle(initialPresent: boolean, fallbackMs = 320) {
  let phase: PresencePhase = initialPresent ? "open" : "unmounted";
  let fallback: ReturnType<typeof globalThis.setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const clearFallback = () => {
    if (fallback === null) return;
    globalThis.clearTimeout(fallback);
    fallback = null;
  };
  const update = (next: PresencePhase) => {
    if (phase === next) return;
    phase = next;
    for (const listener of listeners) listener();
  };
  const finishExit = () => {
    if (phase !== "closing") return;
    clearFallback();
    update("unmounted");
  };
  const setPresent = (present: boolean) => {
    if (present) {
      clearFallback();
      update("open");
      return;
    }
    if (phase === "unmounted" || phase === "closing") return;
    update("closing");
    fallback = globalThis.setTimeout(finishExit, fallbackMs);
  };

  return {
    getSnapshot: () => phase,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPresent,
    finishExit,
    destroy: () => {
      clearFallback();
      listeners.clear();
    },
  };
}

export function Presence({
  present,
  children,
  fallbackMs = 320,
  inertWhenClosing = false,
}: {
  present: boolean;
  children: ReactElement<Record<string, unknown>> | null;
  fallbackMs?: number;
  inertWhenClosing?: boolean;
}) {
  const [lifecycle] = useState(() => createPresenceLifecycle(present, fallbackMs));
  const lifecyclePhase = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getSnapshot,
    lifecycle.getSnapshot,
  );
  const lastChildRef = useRef<ReactElement<Record<string, unknown>> | null>(children);
  if (present && children) lastChildRef.current = children;

  useEffect(() => lifecycle.setPresent(present), [lifecycle, present]);
  useEffect(() => () => lifecycle.destroy(), [lifecycle]);

  if (!present && lifecyclePhase === "unmounted") return null;
  const child = present && children ? children : lastChildRef.current;
  if (!child) return null;

  const phase = present ? "open" : "closing";
  const previousTransitionEnd = child.props.onTransitionEnd as
    | ((event: TransitionEvent<HTMLElement>) => void)
    | undefined;
  return cloneElement(child, {
    "data-presence": phase,
    onTransitionEnd: (event: TransitionEvent<HTMLElement>) => {
      previousTransitionEnd?.(event);
      if (event.target === event.currentTarget) lifecycle.finishExit();
    },
    ...(inertWhenClosing
      ? {
          inert: phase === "closing",
          "aria-hidden": phase === "closing" ? true : undefined,
        }
      : {}),
  });
}
