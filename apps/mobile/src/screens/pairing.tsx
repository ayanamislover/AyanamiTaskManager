import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ClipboardTextIcon as ClipboardText } from "@phosphor-icons/react/dist/icons/ClipboardText";
import { DesktopTowerIcon as DesktopTower } from "@phosphor-icons/react/dist/icons/DesktopTower";
import { QrCodeIcon as QrCode } from "@phosphor-icons/react/dist/icons/QrCode";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/icons/ShieldCheck";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/dist/icons/WarningCircle";
import type { PairingPayload } from "@ayanami-task/sync-protocol";
import { dismissLink, pair, useAppState } from "../app-state.js";
import { parsePairingInput, relayLabel } from "../data/pairing-input.js";
import { Wordmark } from "../ui/wordmark.js";
import { Scanner } from "./scanner.js";
// 与桌面端、应用图标同一张品牌图（仓库根的 logo.png），构建时打进 APK。
import logoUrl from "../../../../logo.png";

/**
 * 配对页（未配对时的首页）。三条路进来：扫码、粘贴、系统深链（atm1:…）。
 * 无论哪条，解出配对码后都先停在确认卡上——点「完成配对」才写入安全存储。
 */
export function PairingScreen() {
  const app = useAppState();
  const [mode, setMode] = useState<"idle" | "paste" | "scan">("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<PairingPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<null | (() => PairingPayload)>(null);
  const textId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => setScrolled(element.scrollTop > 4);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);
  const pendingLink = app.kind === "unpaired" ? app.pendingLink : null;
  const notice = app.kind === "unpaired" ? app.notice : null;

  useEffect(() => {
    if (!pendingLink) return;
    if (pendingLink.kind === "pair") {
      setCandidate(pendingLink.payload);
      setError(null);
    } else {
      setError(pendingLink.error.message);
      setMode("paste");
    }
    dismissLink();
  }, [pendingLink]);

  useEffect(() => {
    if (import.meta.env.VITE_ATM_DEMO !== "1") return;
    void import("../data/demo.js").then((module) => setDemo(() => module.demoPairingPayload));
  }, []);

  const accept = useCallback((raw: string) => {
    const result = parsePairingInput(raw);
    if (result.ok) {
      setCandidate(result.payload);
      setError(null);
      setMode("idle");
    } else {
      setError(result.error.message);
      setMode("paste");
      setText(raw);
    }
  }, []);

  const onScanned = useCallback((raw: string) => accept(raw), [accept]);
  const onCameraUnavailable = useCallback((message: string) => {
    setError(message);
    setMode("paste");
  }, []);
  const closeScanner = useCallback(() => setMode("paste"), []);

  const confirm = async () => {
    if (!candidate) return;
    setBusy(true);
    setError(null);
    try {
      await pair(candidate);
    } catch {
      setError("没能保存配对信息，请重试");
      setBusy(false);
    }
  };

  return (
    <section className="screen pairing-screen">
      <div className="screen-scroll" ref={scrollRef}>
        {/* 没有顶栏的页面也要给状态栏垫一层底：内容滚上去时不和状态栏图标叠在一起。 */}
        <div
          className="status-scrim"
          data-scrolled={scrolled ? "true" : "false"}
          aria-hidden="true"
        />
        <div className="screen-content pairing-content">
          <div className="pairing-hero">
            <img className="pairing-avatar" src={logoUrl} alt="" width={88} height={88} />
            <Wordmark className="pairing-wordmark" />
            <p className="pairing-lede">把电脑上的任务装进口袋：随时看进度，想到什么就发给电脑。</p>
          </div>

          {notice ? (
            <p className="pairing-notice" role="status">
              {notice}
            </p>
          ) : null}

          {candidate ? (
            <div className="card confirm-card">
              <span className="confirm-icon" aria-hidden="true">
                <DesktopTower size={24} weight="duotone" />
              </span>
              <strong>将与「{candidate.n || "电脑"}」配对</strong>
              <dl className="confirm-facts">
                <div>
                  <dt>中继</dt>
                  <dd className="mono">{relayLabel(candidate.u)}</dd>
                </div>
                <div>
                  <dt>应用</dt>
                  <dd className="mono">{candidate.a}</dd>
                </div>
              </dl>
              <p className="confirm-hint">
                <ShieldCheck size={15} weight="bold" aria-hidden="true" />
                确认这是你自己的电脑和中继。配对后，这台手机能看到它的任务，也能给它发任务。
              </p>
              {error ? <p className="inline-error">{error}</p> : null}
              <div className="footer-pair">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => setCandidate(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() => void confirm()}
                >
                  完成配对
                </button>
              </div>
            </div>
          ) : (
            <>
              <ol className="card pairing-steps">
                <li>
                  <span className="step-index">1</span>
                  <span>在电脑 ATM 打开「设置 → 手机同步」</span>
                </li>
                <li>
                  <span className="step-index">2</span>
                  <span>点「配对手机」，屏幕上会出现二维码</span>
                </li>
                <li>
                  <span className="step-index">3</span>
                  <span>用这台手机扫一下，或者复制配对码粘贴到下面</span>
                </li>
              </ol>

              <div className="pairing-actions">
                <button
                  type="button"
                  className="button primary block large"
                  onClick={() => setMode("scan")}
                >
                  <QrCode size={20} weight="bold" aria-hidden="true" />
                  扫描二维码
                </button>
                {mode !== "paste" ? (
                  <button
                    type="button"
                    className="button block large"
                    onClick={() => setMode("paste")}
                  >
                    <ClipboardText size={20} weight="bold" aria-hidden="true" />
                    粘贴配对码
                  </button>
                ) : null}
              </div>

              {mode === "paste" ? (
                <form
                  className="card paste-card"
                  onSubmit={(event) => {
                    event.preventDefault();
                    accept(text);
                  }}
                >
                  <label htmlFor={textId} className="field-label">
                    配对码
                  </label>
                  <div
                    className="input-shell field-shell is-multiline"
                    data-invalid={error ? "true" : "false"}
                  >
                    <textarea
                      id={textId}
                      className="mono"
                      rows={4}
                      value={text}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      placeholder="atm1:…（从电脑复制的整段文字也可以）"
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `${textId}-error` : undefined}
                      onChange={(event) => {
                        setText(event.target.value);
                        if (error) setError(null);
                      }}
                    />
                  </div>
                  {error ? (
                    <p className="inline-error" id={`${textId}-error`}>
                      <WarningCircle size={16} weight="bold" aria-hidden="true" />
                      {error}
                    </p>
                  ) : null}
                  <button type="submit" className="button primary block" disabled={!text.trim()}>
                    识别配对码
                  </button>
                </form>
              ) : null}

              {demo ? (
                <button
                  type="button"
                  className="text-button demo-button"
                  onClick={() => {
                    setError(null);
                    setCandidate(demo());
                  }}
                >
                  使用演示数据（仅开发构建）
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
      {mode === "scan" ? (
        <Scanner onResult={onScanned} onClose={closeScanner} onUnavailable={onCameraUnavailable} />
      ) : null}
    </section>
  );
}
