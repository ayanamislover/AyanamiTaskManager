import { useId } from "react";
import { WORDMARK_PATH, WORDMARK_VIEW_BOX } from "./wordmark-path.js";

/** 花体字标，与桌面端侧栏同一条路径；渐变色取主题 token，切换明暗时跟着变。 */
export function Wordmark({ className = "" }: { className?: string }) {
  const gradientId = `wordmark-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className={`wordmark ${className}`.trim()}
      viewBox={WORDMARK_VIEW_BOX}
      role="img"
      aria-label="AyanamiTaskManager"
      preserveAspectRatio="xMinYMid meet"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" className="wordmark-stop-a" />
          <stop offset="0.6" className="wordmark-stop-b" />
          <stop offset="1" className="wordmark-stop-c" />
        </linearGradient>
      </defs>
      <path d={WORDMARK_PATH} fill={`url(#${gradientId})`} />
    </svg>
  );
}
