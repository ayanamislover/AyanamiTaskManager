import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Presence } from "./presence.js";
import { useBackHandler } from "./nav.js";

/**
 * 胶囊分段（优先级、主题）：role=radiogroup，方向键在选项间移动并选中。
 * 形态照桌面端 .atm-tabs：柔色槽里一颗白色胶囊。
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (event: KeyboardEvent, index: number) => {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className="segmented-option"
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** 开关：整行都能点（44px 以上），role=switch。 */
export function SwitchRow({
  checked,
  onChange,
  title,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="switch-row"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-copy">
        <strong>{title}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </button>
  );
}

/**
 * 底部弹出的确认框：危险操作（解除配对、替换配对）与深链配对确认都用它。
 * 返回键、点遮罩都等同「取消」。
 */
export function ConfirmSheet({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "取消",
  tone = "primary",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useBackHandler(open, onCancel);
  const sheetRef = useRef<HTMLDivElement>(null);
  // 打开时把焦点移进对话框（读屏从标题开始读），但不落在任何按钮上：触屏上不该出现一圈焦点环。
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => sheetRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return (
    <Presence present={open} fallbackMs={320}>
      {open ? (
        <div
          className="sheet-backdrop"
          onClick={(event) => event.target === event.currentTarget && onCancel()}
        >
          <div
            className="sheet"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="sheet-title"
            tabIndex={-1}
            ref={sheetRef}
          >
            <span className="sheet-grip" aria-hidden="true" />
            <h2 id="sheet-title">{title}</h2>
            <div className="sheet-body">{children}</div>
            <div className="sheet-actions">
              <button type="button" className="button" onClick={onCancel} disabled={busy}>
                {cancelLabel}
              </button>
              <button
                type="button"
                className={tone === "danger" ? "button danger-solid" : "button primary"}
                onClick={onConfirm}
                disabled={busy}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Presence>
  );
}
