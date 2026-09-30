import { useCallback, useEffect, useRef, useState } from "react";
import type { AyanamiClient } from "@ayanami-task/client";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import { LoadingRows } from "../components/async-state.js";
import type { PresenceRootProps } from "../components/presence.js";
import { QrCode } from "../components/qr-code.js";
import type { DesktopBridge, Notify } from "../contracts.js";
import { useDialogAccessibility } from "../hooks/use-dialog-accessibility.js";
import { formatCountdown, PAIRING_VISIBLE_MS, problemText } from "./mobile-sync-support.js";

type PairingState =
  | { phase: "loading" }
  | { phase: "shown"; code: string; shownAt: number }
  | { phase: "hidden" }
  | { phase: "error"; message: string };

/**
 * 「添加手机」对话框：二维码 + 可复制的配对码。
 *
 * 配对码里有中继 token 和空间密钥，所以只放在这个组件自己的 state 里：
 * 不进 react-query 缓存、不写日志；2 分钟后或对话框关掉就丢掉。
 */
export function PairingDialog({
  client,
  desktop,
  notify,
  close,
  ...presenceRootProps
}: {
  client: AyanamiClient;
  desktop?: DesktopBridge;
  notify: Notify;
  close: () => void;
} & PresenceRootProps) {
  const closing = presenceRootProps["data-presence"] === "closing";
  const dialogRef = useDialogAccessibility(close, !closing);
  const [state, setState] = useState<PairingState>({ phase: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const request = useRef(0);

  const generate = useCallback(() => {
    const id = ++request.current;
    setState({ phase: "loading" });
    client.createSyncPairing().then(
      (pairing) => {
        if (request.current !== id) return;
        const shownAt = Date.now();
        setNow(shownAt);
        setState({ phase: "shown", code: pairing.pairingCode, shownAt });
      },
      (error: unknown) => {
        if (request.current !== id) return;
        setState({
          phase: "error",
          message: problemText(error instanceof Error ? error.message : error) ?? "未知错误",
        });
      },
    );
  }, [client]);

  // 打开时生成一次。StrictMode 开发模式会把 effect 跑两遍，靠 ref 挡住第二次，
  // 免得还没有空间时连发两个 POST /sync/pairing。
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    generate();
  }, [generate]);

  const shownAt = state.phase === "shown" ? state.shownAt : null;
  useEffect(() => {
    if (shownAt === null) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      if (current - shownAt >= PAIRING_VISIBLE_MS) setState({ phase: "hidden" });
      else setNow(current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [shownAt]);

  // 换视图时原来有焦点的按钮可能被撤掉（例如 2 分钟到了「复制配对码」消失），
  // 焦点不能掉回 body：落到新视图的第一个按钮上。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || closing || dialog.contains(document.activeElement)) return;
    dialog.querySelector<HTMLElement>(".atm-modal-body button")?.focus();
  }, [state.phase, closing, dialogRef]);

  const copy = async (code: string) => {
    try {
      if (desktop?.copyText) await desktop.copyText(code);
      else await navigator.clipboard.writeText(code);
      notify("配对码已复制，粘贴到手机上后记得清空剪贴板");
    } catch (error) {
      notify(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div {...presenceRootProps} className="atm-modal-backdrop">
      <section
        ref={dialogRef}
        className="atm-modal atm-pairing-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-pairing-title"
        tabIndex={-1}
      >
        <header className="atm-modal-head">
          <h2 id="sync-pairing-title">添加手机</h2>
          <button className="atm-button atm-icon-button" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="atm-modal-body">
          {state.phase === "loading" ? (
            <LoadingRows count={2} />
          ) : state.phase === "error" ? (
            <div className="atm-form">
              <div className="atm-inline-error" role="alert">
                配对码生成失败：{state.message}
              </div>
              <div className="atm-actions">
                <button className="atm-button" type="button" onClick={generate}>
                  重试
                </button>
              </div>
            </div>
          ) : state.phase === "hidden" ? (
            <div className="atm-pairing-hidden">
              <strong>配对码已隐藏</strong>
              <span className="atm-row-sub">配对码只显示 2 分钟。还没扫完的话，再生成一次。</span>
              <button className="atm-button" type="button" onClick={generate}>
                重新显示
              </button>
            </div>
          ) : (
            <div className="atm-pairing">
              <div className="atm-qr-tile">
                <QrCode text={state.code} label="手机同步配对二维码" />
              </div>
              <div className="atm-pairing-side">
                <ol className="atm-pairing-steps">
                  <li>在手机上打开 ATM，点「扫码配对」。</li>
                  <li>扫描左边的二维码；扫不了就复制下面的配对码，在手机上粘贴。</li>
                </ol>
                <div className="atm-pairing-code" role="group" aria-label="配对码">
                  <code>{state.code}</code>
                </div>
                <div className="atm-pairing-meta">
                  <button
                    className="atm-button"
                    type="button"
                    data-dialog-autofocus
                    onClick={() => void copy(state.code)}
                  >
                    复制配对码
                  </button>
                  <span className="atm-row-sub">
                    {formatCountdown(PAIRING_VISIBLE_MS - (now - state.shownAt))} 后自动隐藏
                  </span>
                </div>
                <p className="atm-sync-note" data-tone="warning">
                  配对码包含中继 token 和加密密钥，只给自己的手机看。
                </p>
              </div>
            </div>
          )}
        </div>
        <footer className="atm-modal-foot">
          <button className="atm-button" type="button" onClick={close}>
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}
