import { useEffect, useId, useRef, useState } from "react";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/icons/CaretDown";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/icons/CheckCircle";
import { Presence } from "./presence.js";

export type AtmSelectOption = { value: string; label: string };

export function AtmSelect({
  id,
  ariaLabel,
  value,
  options,
  onChange,
  className = "",
}: {
  id?: string;
  ariaLabel: string;
  value: string;
  options: AtmSelectOption[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [openInput, setOpenInput] = useState<"pointer" | "keyboard">("pointer");
  const [placement, setPlacement] = useState<"top" | "bottom">("bottom");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const openingIndexRef = useRef(0);
  const listboxId = `atm-select-${useId().replaceAll(":", "")}`;
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selectedLabel = options[selectedIndex]?.label ?? options[0]?.label ?? "未选择";

  const openAt = (index: number, input: "pointer" | "keyboard") => {
    openingIndexRef.current = Math.max(0, Math.min(index, options.length - 1));
    setOpenInput(input);
    const root = rootRef.current;
    if (root) {
      const bounds = root.getBoundingClientRect();
      const boundary = root.closest(".atm-modal, .atm-drawer")?.getBoundingClientRect();
      const desired = Math.min(320, options.length * 34 + 12);
      const spaceBelow = (boundary?.bottom ?? window.innerHeight) - bounds.bottom - 12;
      const spaceAbove = bounds.top - (boundary?.top ?? 0) - 12;
      setPlacement(spaceBelow < desired && spaceAbove > spaceBelow ? "top" : "bottom");
    }
    setOpen(true);
  };
  const closeAndFocusTrigger = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeAndFocusTrigger();
  };
  const focusOption = (index: number) => {
    const next = (index + options.length) % options.length;
    optionRefs.current[next]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() =>
      optionRefs.current[openingIndexRef.current]?.focus(),
    );
    const handleOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handleOutsidePress, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handleOutsidePress, true);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`atm-select atm-field-shell ${className}`.trim()}
      data-open={open ? "true" : "false"}
      data-open-input={openInput}
      data-placement={placement}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="atm-select-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={(event) =>
          open
            ? closeAndFocusTrigger()
            : openAt(selectedIndex, event.detail === 0 ? "keyboard" : "pointer")
        }
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openAt(selectedIndex, "keyboard");
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            openAt(selectedIndex < 0 ? options.length - 1 : selectedIndex, "keyboard");
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            closeAndFocusTrigger();
          }
        }}
      >
        <span>{selectedLabel}</span>
        <CaretDown size={14} aria-hidden="true" />
      </button>
      <Presence present={open} inertWhenClosing fallbackMs={240}>
        {open ? (
          <div className="atm-select-popover" id={listboxId} role="listbox" aria-label={ariaLabel}>
            {options.map((option, index) => (
              <button
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                className="atm-select-option"
                role="option"
                aria-selected={option.value === value}
                data-selected={option.value === value ? "true" : "false"}
                key={option.value || "__empty"}
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
                    event.stopPropagation();
                    closeAndFocusTrigger();
                  } else if (event.key === "Tab") {
                    setOpen(false);
                  }
                }}
              >
                <span>{option.label}</span>
                {option.value === value ? <CheckCircle size={15} weight="fill" /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </Presence>
    </div>
  );
}
