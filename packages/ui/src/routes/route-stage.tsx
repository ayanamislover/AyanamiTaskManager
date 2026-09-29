import { useCallback, useEffect, useState, type ReactNode } from "react";

/** 新页面最多在后台准备这么久；超时就直接换上，让它自己显示加载态。 */
export const ROUTE_HOLD_MS = 450;

/**
 * 切到一个需要读数据的页面时，先别急着把它换上来。
 *
 * 直接换上的话，页面第一帧只有骨架和「尚未设置」「没有进行中任务」这类空态，
 * 几百毫秒后数据回来再整块替换——看起来就是右边闪一下，空态还说的是错的。
 *
 * 这里让新页面先在后台挂载、开始读取，旧页面原样留在前面；新页面报告
 * 「首屏数据齐了」就立刻换上，最多等 ROUTE_HOLD_MS。两个页面各自渲染各自的数据，
 * 不会出现标题是新项目、列表还是旧项目的错位。
 *
 * 不需要等待的页面（defer 为 false）照旧立即切换。
 */
export function RouteStage({
  route,
  defer,
  render,
}: {
  route: string;
  /** 目标页面会不会调用 onReady；不会的话等待没有意义，直接切。 */
  defer: boolean;
  render: (route: string, stage: RouteStageSlot) => ReactNode;
}) {
  const [shown, setShown] = useState(route);
  // 目标不需要等待时，在渲染期间直接对齐（React 推荐的「随 props 调整 state」写法），
  // 不先画一帧旧页面。
  if (route !== shown && !defer) setShown(route);
  const pending = route !== shown && defer ? route : null;

  useEffect(() => {
    if (pending === null) return;
    const timer = window.setTimeout(() => setShown(pending), ROUTE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const promote = useCallback(() => {
    if (pending !== null) setShown(pending);
  }, [pending]);

  return (
    <>
      <div className="atm-route-layer" key={shown}>
        {render(shown, SHOWN)}
      </div>
      {pending === null ? null : (
        // 后台准备中的页面：不占版面、看不见、不能聚焦，读屏也读不到。
        <div
          className="atm-route-layer atm-route-pending"
          key={pending}
          aria-hidden="true"
          inert
          data-testid="route-pending"
        >
          {render(pending, { pending: true, onReady: promote })}
        </div>
      )}
    </>
  );
}

export type RouteStageSlot = {
  /** 还在后台准备、用户看不见：页面不该响应全局快捷键之类的事件。 */
  pending: boolean;
  /** 首屏数据齐了（成功或失败都算）时调用一次。 */
  onReady: () => void;
};

const SHOWN: RouteStageSlot = { pending: false, onReady: () => {} };
