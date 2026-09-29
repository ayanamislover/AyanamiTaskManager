import { useId } from "react";
import { WORDMARK_PATH, WORDMARK_VIEW_BOX } from "./wordmark-path.js";

/** 侧栏顶部的花体字标。渐变色取自主题 token，切换明暗时跟着变。 */
export function Wordmark() {
  const gradientId = `atm-wordmark-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className="atm-wordmark"
      viewBox={WORDMARK_VIEW_BOX}
      role="img"
      aria-label="AyanamiTaskManager"
      preserveAspectRatio="xMinYMid meet"
    >
      <title>AyanamiTaskManager</title>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" className="atm-wordmark-stop-a" />
          <stop offset="0.6" className="atm-wordmark-stop-b" />
          <stop offset="1" className="atm-wordmark-stop-c" />
        </linearGradient>
      </defs>
      <path d={WORDMARK_PATH} fill={`url(#${gradientId})`} />
    </svg>
  );
}
