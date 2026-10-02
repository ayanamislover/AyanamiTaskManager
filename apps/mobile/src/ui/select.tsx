import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/icons/CaretDown";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/icons/CheckCircle";
import { useBackHandler } from "./nav.js";
import { Presence } from "./presence.js";

export type SelectOption = { value: string; label: string; hint?: string };

/**
 * 自绘下拉（不用原生 select：Android 上它弹的是系统样式的对话框，和柔彩界面不搭）。
 * 交互照桌面端 AtmSelect：combobox 触发器 + listbox 弹层，方向键 / Home / End / Esc 可用，
 * 弹层带进出场；手机上另外让系统返回键先关弹层。
 *
 * 焦点环只由外壳（.field-shell）画，触发器自己不画——一个字段只有一个框。
 */
export function Select({
  id,
  label,
  value,
  options,
  onChange,
  placeholder = "请选择",
}: {
  id?: string;
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"top" | "bottom">("bottom");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusIndex = useRef(0);
  const listboxId = `select-${useId().replace(/:/g, "")}`;
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, []);

  const openAt = (index: number) => {
    focusIndex.current = Math.max(0, Math.min(index, options.length - 1));
    const bounds = rootRef.current?.getBoundingClientRect();
    if (bounds) {
      const desired = Math.min(320, options.length * 48 + 12);
      const below = window.innerHeight - bounds.bottom - 16;
      const above = bounds.top - 16;
      setPlacement(below < desired && above > below ? "top" : "bottom");
    }
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    close();
  };

  const focusOption = (index: number) => {
    const next = (index + options.length) % options.length;
    optionRefs.current[next]?.focus();
  };

  useBackHandler(open, close);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      optionRefs.current[focusIndex.current]?.focus({ preventScroll: true }),
    );
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open, close]);

  return (
    <div
      ref={rootRef}
      className="select field-shell"
      data-open={open ? "true" : "false"}
      data-placement={placement}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-label={label}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => (open ? close() : openAt(Math.max(0, selectedIndex)))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openAt(
              selectedIndex < 0
                ? event.key === "ArrowUp"
                  ? options.length - 1
                  : 0
                : selectedIndex,
            );
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          }
        }}
      >
        <span className={selected ? "select-value" : "select-value is-placeholder"}>
          {selected?.label ?? placeholder}
        </span>
        <CaretDown size={16} weight="bold" aria-hidden="true" />
      </button>
      <Presence present={open} fallbackMs={260}>
        {open ? (
          <div className="select-popover" id={listboxId} role="listbox" aria-label={label}>
            {options.map((option, index) => (
              <button
                key={option.value}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                className="select-option"
                role="option"
                aria-selected={option.value === value}
                data-selected={option.value === value ? "true" : "false"}
                onClick={() => choose(index)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    focusOption(index + 1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    focusOption(index - 1);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    focusOption(0);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    focusOption(options.length - 1);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    close();
                  } else if (event.key === "Tab") {
                    close(false);
                  }
                }}
              >
                <span className="select-option-text">
                  <span>{option.label}</span>
                  {option.hint ? <small>{option.hint}</small> : null}
                </span>
                {option.value === value ? (
                  <CheckCircle size={18} weight="fill" aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </Presence>
    </div>
  );
}
