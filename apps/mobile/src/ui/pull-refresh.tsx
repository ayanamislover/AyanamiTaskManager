import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowClockwiseIcon as ArrowClockwise } from "@phosphor-icons/react/dist/icons/ArrowClockwise";

const THRESHOLD = 72;
const MAX_PULL = 120;
/** 刷新很快（几十毫秒）时指示器一闪而过像是没反应：至少转这么久再收起。 */
export const MIN_SPIN_MS = 600;

export function useMinimumDuration(active: boolean, minimumMs: number): boolean {
  const [shown, setShown] = useState(active);
  const since = useRef(0);
  useEffect(() => {
    if (active) {
      since.current = Date.now();
      setShown(true);
      return;
    }
    const remaining = minimumMs - (Date.now() - since.current);
    if (remaining <= 0) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(false), remaining);
    return () => clearTimeout(timer);
  }, [active, minimumMs]);
  return shown;
}

/**
 * 下拉刷新：滚动区在顶端时往下拉，超过阈值松手即刷新。
 * 指示器是一颗柔彩小圆钮，跟着手指下移并旋转；刷新进行中保持转动，直到 refreshing 变回 false。
 * 只处理触摸；桌面浏览器调试时用顶栏的刷新按钮。
 */
export function usePullToRefresh(
  scrollRef: RefObject<HTMLDivElement | null>,
  refreshingNow: boolean,
  onRefresh: () => void,
) {
  const refreshing = useMinimumDuration(refreshingNow, MIN_SPIN_MS);
  const [pull, setPull] = useState(0);
  const start = useRef<{ y: number; x: number; active: boolean } | null>(null);
  const latest = useRef({ pull: 0, onRefresh });
  latest.current.onRefresh = onRefresh;

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || element.scrollTop > 0) {
        start.current = null;
        return;
      }
      start.current = { y: touch.clientY, x: touch.clientX, active: false };
    };
    const onMove = (event: TouchEvent) => {
      const origin = start.current;
      const touch = event.touches[0];
      if (!origin || !touch) return;
      const dy = touch.clientY - origin.y;
      const dx = Math.abs(touch.clientX - origin.x);
      if (!origin.active) {
        // 横向手势或往上滑不接管。
        if (dy < 6 || dx > dy) {
          if (dy < 0 || dx > 10) start.current = null;
          return;
        }
        origin.active = true;
      }
      if (element.scrollTop > 0) return;
      event.preventDefault();
      // 阻尼：越往下越沉。
      const distance = Math.min(MAX_PULL, dy * 0.5);
      latest.current.pull = distance;
      setPull(distance);
    };
    const onEnd = () => {
      if (start.current?.active && latest.current.pull >= THRESHOLD * 0.8)
        latest.current.onRefresh();
      start.current = null;
      latest.current.pull = 0;
      setPull(0);
    };
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd);
    element.addEventListener("touchcancel", onEnd);
    return () => {
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onEnd);
    };
  }, [scrollRef]);

  const visible = pull > 0 || refreshing;
  const offset = refreshing && pull === 0 ? THRESHOLD * 0.6 : pull * 0.6;
  const ready = pull >= THRESHOLD * 0.8;
  return (
    <div
      className="pull-indicator"
      data-visible={visible ? "true" : "false"}
      data-refreshing={refreshing ? "true" : "false"}
      data-ready={ready ? "true" : "false"}
      data-dragging={pull > 0 ? "true" : "false"}
      style={{ transform: `translate(-50%, ${offset}px)` }}
      aria-hidden={!visible}
      role="status"
    >
      <span style={refreshing ? undefined : { transform: `rotate(${pull * 3}deg)` }}>
        <ArrowClockwise size={18} weight="bold" aria-hidden="true" />
      </span>
      <span className="visually-hidden">
        {refreshing ? "正在刷新" : ready ? "松手刷新" : "下拉刷新"}
      </span>
    </div>
  );
}
