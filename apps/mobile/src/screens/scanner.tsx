import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { ClipboardTextIcon as ClipboardText } from "@phosphor-icons/react/dist/icons/ClipboardText";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import { useBackHandler } from "../ui/nav.js";

const SCAN_INTERVAL_MS = 120;
const SAMPLE_EDGE = 720;

/**
 * 全屏扫码：getUserMedia 取后置摄像头，jsQR 每 120 ms 解一帧。
 * 相机权限由 Capacitor 的 WebChromeClient 代为向系统申请；被拒或没有相机时回调 onUnavailable，
 * 由配对页退回「粘贴配对码」。
 */
export function Scanner({
  onResult,
  onClose,
  onUnavailable,
}: {
  onResult: (text: string) => void;
  onClose: () => void;
  onUnavailable: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const done = useRef(false);
  useBackHandler(true, onClose);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    const scan = () => {
      const video = videoRef.current;
      if (!video || !context || video.readyState < 2 || done.current) return;
      const scale = Math.min(1, SAMPLE_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.round(video.videoWidth * scale);
      const height = Math.round(video.videoHeight * scale);
      if (!width || !height) return;
      canvas.width = width;
      canvas.height = height;
      context.drawImage(video, 0, 0, width, height);
      const code = jsQR(context.getImageData(0, 0, width, height).data, width, height, {
        inversionAttempts: "attemptBoth",
      });
      if (code?.data) {
        done.current = true;
        navigator.vibrate?.(30);
        onResult(code.data);
      }
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        onUnavailable("这台设备不支持在应用内调用相机，请改为粘贴配对码。");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 1280 },
          },
        });
      } catch (error) {
        const name = error instanceof DOMException ? error.name : "";
        onUnavailable(
          name === "NotAllowedError" || name === "SecurityError"
            ? "没有相机权限。可以在系统设置里允许「ATM 任务」使用相机，或者改为粘贴配对码。"
            : "打不开相机，请改为粘贴配对码。",
        );
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      setReady(true);
      timer = setInterval(scan, SCAN_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [onResult, onUnavailable]);

  return (
    <div className="scanner" role="dialog" aria-modal="true" aria-label="扫描配对二维码">
      <video
        ref={videoRef}
        className="scanner-video"
        playsInline
        muted
        data-ready={ready ? "true" : "false"}
      />
      <div className="scanner-shade" aria-hidden="true">
        <span className="scanner-frame">
          <i />
          <i />
          <i />
          <i />
          <span className="scanner-line" />
        </span>
      </div>
      <div className="scanner-top">
        <button
          type="button"
          className="icon-button on-dark"
          aria-label="关闭扫码"
          onClick={onClose}
        >
          <X size={20} weight="bold" aria-hidden="true" />
        </button>
      </div>
      <div className="scanner-bottom">
        <p>{ready ? "对准电脑屏幕上的二维码" : "正在打开相机…"}</p>
        <button type="button" className="button on-dark" onClick={onClose}>
          <ClipboardText size={18} weight="bold" aria-hidden="true" />
          改为粘贴配对码
        </button>
      </div>
    </div>
  );
}
