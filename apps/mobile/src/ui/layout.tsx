import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { CaretLeftIcon as CaretLeft } from "@phosphor-icons/react/dist/icons/CaretLeft";
import type { TaskCard } from "@ayanami-task/sync-protocol";
import { DISPATCH_LABELS, dispatchTone, statusLabel, statusTone, type Tone } from "./labels.js";
import { handleBack } from "./nav.js";

/**
 * 一屏：滚动区里是吸顶的顶栏和内容，底部可选一条操作栏。
 * 顶栏在滚动区里面而不是上面：内容往上滚时从柔光顶栏下面穿过，而不是在一条看不见的线上被截断。
 * 系统栏留白由 --inset-top / --inset-bottom 提供（MainActivity 量好后注入）。
 */
export function Screen({
  title,
  subtitle,
  leading,
  actions,
  children,
  footer,
  overlay,
  scrollRef,
  className = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** 不随内容滚动、叠在屏幕上的东西（下拉刷新指示器）。 */
  overlay?: ReactNode;
  scrollRef?: RefObject<HTMLDivElement | null>;
  className?: string;
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = scrollRef ?? localRef;
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onScroll = () => setScrolled(element.scrollTop > 4);
    onScroll();
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [ref]);
  return (
    <section className={`screen ${className}`.trim()}>
      <div className="screen-scroll" ref={ref}>
        <header className="topbar" data-scrolled={scrolled ? "true" : "false"}>
          <div className="topbar-row">
            {leading ?? <BackButton />}
            <div className="topbar-title">
              {typeof title === "string" ? <h1>{title}</h1> : title}
              {subtitle ? <span className="topbar-subtitle">{subtitle}</span> : null}
            </div>
            {actions ? <div className="topbar-actions">{actions}</div> : null}
          </div>
        </header>
        <div className="screen-content">{children}</div>
      </div>
      {overlay}
      {footer ? <footer className="bottom-bar">{footer}</footer> : null}
    </section>
  );
}

export function BackButton() {
  return (
    <button type="button" className="icon-button" aria-label="返回" onClick={() => handleBack()}>
      <CaretLeft size={20} weight="bold" aria-hidden="true" />
    </button>
  );
}

export function IconButton({
  label,
  onClick,
  children,
  busy = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      aria-busy={busy || undefined}
      data-busy={busy ? "true" : "false"}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function SectionTitle({
  children,
  count,
  action,
}: {
  children: ReactNode;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="section-title">
      <h2>
        {children}
        {count !== undefined ? <span className="section-count">{count}</span> : null}
      </h2>
      {action}
    </div>
  );
}

export function ToneBadge({ tone, children }: { tone: Tone | "neutral"; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <ToneBadge tone={statusTone(status)}>{statusLabel(status)}</ToneBadge>;
}

export function DispatchBadge({ dispatch }: { dispatch: NonNullable<TaskCard["dispatch"]> }) {
  return (
    <span className="badge dispatch-badge" data-tone={dispatchTone(dispatch.state)}>
      <span className="dispatch-dot" data-state={dispatch.state} aria-hidden="true" />
      Claude {DISPATCH_LABELS[dispatch.state]}
    </span>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      aria-label={label ?? "进度"}
    >
      <span style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  tone = "neutral",
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "danger" | "warning";
}) {
  return (
    <div className="empty" data-tone={tone}>
      <span className="empty-icon" aria-hidden="true">
        {icon}
      </span>
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
