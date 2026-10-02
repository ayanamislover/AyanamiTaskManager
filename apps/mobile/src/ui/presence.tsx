import {
  cloneElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type TransitionEvent,
} from "react";

/**
 * 进出场：与桌面端 packages/ui 的 Presence 同一套约定——
 * 入场靠 CSS 的 @starting-style，退场时挂 data-presence="closing"，过渡结束（或兜底超时）后卸载。
 */
export function Presence({
  present,
  children,
  fallbackMs = 320,
}: {
  present: boolean;
  children: ReactElement<Record<string, unknown>> | null;
  fallbackMs?: number;
}) {
  const [mounted, setMounted] = useState(present);
  const lastChild = useRef(children);
  if (present && children) lastChild.current = children;

  useEffect(() => {
    if (present) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), fallbackMs);
    return () => clearTimeout(timer);
  }, [present, fallbackMs]);

  if (!present && !mounted) return null;
  const child = present && children ? children : lastChild.current;
  if (!child) return null;
  const previous = child.props.onTransitionEnd as
    | ((event: TransitionEvent<HTMLElement>) => void)
    | undefined;
  return cloneElement(child, {
    "data-presence": present ? "open" : "closing",
    inert: present ? undefined : true,
    onTransitionEnd: (event: TransitionEvent<HTMLElement>) => {
      previous?.(event);
      if (!present && event.target === event.currentTarget) setMounted(false);
    },
  });
}
