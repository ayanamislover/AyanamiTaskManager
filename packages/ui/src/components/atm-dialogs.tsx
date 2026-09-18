import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import { useDialogAccessibility } from "../hooks/use-dialog-accessibility.js";
import { Presence, type PresenceRootProps } from "./presence.js";

/**
 * 应用内的确认框与输入框，替代 window.confirm / window.prompt。
 *
 * 原生弹窗由系统绘制，和界面风格完全脱节；更要紧的是 Electron 根本不实现
 * window.prompt——调用直接抛 "prompt() is not supported."，所以凡是靠它取输入的按钮，
 * 在桌面端点了都没有任何反应，只有浏览器预览里是好的。
 */
export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  /** 破坏性操作默认把焦点放在「取消」上，回车不会误触。 */
  tone?: "danger" | "primary";
};

export type PromptOptions = {
  title: string;
  label: string;
  confirmLabel: string;
  placeholder?: string;
  multiline?: boolean;
  maxLength?: number;
};

export type Dialogs = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** 取消返回 null；确认时返回去掉首尾空白后的非空文本。 */
  prompt: (options: PromptOptions) => Promise<string | null>;
};

type DialogRequest =
  | ({ kind: "confirm"; id: number; resolve: (value: boolean) => void } & ConfirmOptions)
  | ({ kind: "prompt"; id: number; resolve: (value: string | null) => void } & PromptOptions);

const missingProvider = () =>
  Promise.reject(new Error("DialogProvider 未挂载：确认框和输入框需要在应用根部提供"));

// 渲染期拿不到 Provider 不报错（静态渲染的组件测试不挂 Provider），真正调用时才失败，
// 不会悄悄当成「用户取消」吞掉。
const DialogContext = createContext<Dialogs>({ confirm: missingProvider, prompt: missingProvider });

export function useDialogs(): Dialogs {
  return useContext(DialogContext);
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const nextId = useRef(0);
  const pending = useRef<DialogRequest | null>(null);

  const settle = useCallback((value: boolean | string | null) => {
    const current = pending.current;
    if (!current) return;
    pending.current = null;
    setRequest(null);
    if (current.kind === "confirm") current.resolve(value === true);
    else current.resolve(typeof value === "string" ? value : null);
  }, []);

  const open = useCallback(
    (next: DialogRequest) => {
      // 同一时刻只有一个请求；新请求顶掉旧请求时，旧的按取消结算，调用方不会永远挂起。
      if (pending.current) settle(pending.current.kind === "confirm" ? false : null);
      pending.current = next;
      setRequest(next);
    },
    [settle],
  );

  const dialogs = useMemo<Dialogs>(
    () => ({
      confirm: (options) =>
        new Promise<boolean>((resolve) =>
          open({ ...options, kind: "confirm", id: ++nextId.current, resolve }),
        ),
      prompt: (options) =>
        new Promise<string | null>((resolve) =>
          open({ ...options, kind: "prompt", id: ++nextId.current, resolve }),
        ),
    }),
    [open],
  );

  return (
    <DialogContext.Provider value={dialogs}>
      {children}
      <Presence present={Boolean(request)} inertWhenClosing>
        {request ? <RequestDialog key={request.id} request={request} settle={settle} /> : null}
      </Presence>
    </DialogContext.Provider>
  );
}

function RequestDialog({
  request,
  settle,
  ...presenceRootProps
}: {
  request: DialogRequest;
  settle: (value: boolean | string | null) => void;
} & PresenceRootProps) {
  const closing = presenceRootProps["data-presence"] === "closing";
  const cancel = () => settle(request.kind === "confirm" ? false : null);
  const dialogRef = useDialogAccessibility(cancel, !closing);
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const titleId = `atm-dialog-title-${request.id}`;
  const bodyId = `atm-dialog-body-${request.id}`;
  const danger = request.kind === "confirm" && request.tone === "danger";
  const submit = () => {
    if (request.kind === "confirm") settle(true);
    else if (trimmed) settle(trimmed);
  };

  return (
    <div {...presenceRootProps} className="atm-modal-backdrop atm-dialog-layer">
      <section
        ref={dialogRef}
        className="atm-modal atm-dialog"
        role={request.kind === "confirm" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={request.kind === "confirm" ? bodyId : undefined}
        tabIndex={-1}
      >
        <form
          className="atm-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <header className="atm-modal-head">
            <h2 id={titleId}>{request.title}</h2>
            <button
              className="atm-button atm-icon-button"
              type="button"
              onClick={cancel}
              aria-label="关闭"
            >
              <X size={17} />
            </button>
          </header>
          <div className="atm-modal-body atm-form">
            {request.kind === "confirm" ? (
              <p id={bodyId} className="atm-dialog-message">
                {request.message}
              </p>
            ) : (
              <div className="atm-field">
                <label htmlFor={bodyId}>{request.label}</label>
                {request.multiline ? (
                  <textarea
                    id={bodyId}
                    data-dialog-autofocus
                    value={value}
                    maxLength={request.maxLength}
                    placeholder={request.placeholder}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => {
                      // 多行输入里回车是换行，Ctrl/⌘ + 回车才提交。
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        submit();
                      }
                    }}
                  />
                ) : (
                  <input
                    id={bodyId}
                    data-dialog-autofocus
                    value={value}
                    maxLength={request.maxLength}
                    placeholder={request.placeholder}
                    onChange={(event) => setValue(event.target.value)}
                  />
                )}
              </div>
            )}
          </div>
          <footer className="atm-modal-foot">
            <button
              className="atm-button"
              type="button"
              onClick={cancel}
              {...(danger ? { "data-dialog-autofocus": true } : {})}
            >
              取消
            </button>
            <button
              className={`atm-button ${danger ? "danger" : "primary"}`}
              type="submit"
              disabled={request.kind === "prompt" && !trimmed}
              {...(request.kind === "confirm" && !danger ? { "data-dialog-autofocus": true } : {})}
            >
              {request.confirmLabel}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
