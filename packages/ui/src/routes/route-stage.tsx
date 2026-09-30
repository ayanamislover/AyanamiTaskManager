import { useCallback, useEffect, useState, type ReactNode } from "react";

/**
 * 这一页是怎么换上来的：首屏读齐（ready）、用户在它上面下了命令（command）、
 * 等满时限（timeout），或者不需要等（direct）。
 */
export type RouteSwap = "direct" | "ready" | "command" | "timeout";

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
 * 等待期间旧页面只是一张预览：设为 inert，不接受点击和键盘。否则用户在旧页上
 * 打开的弹窗、填到一半的内容，会在新页换上时连同旧页一起被卸载（侧栏、顶栏、
 * 任务抽屉都在舞台之外，不受影响）。
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
  const [{ shown, swap }, setStage] = useState<{ shown: string; swap: RouteSwap }>({
    shown: route,
    swap: "direct",
  });
  // 目标不需要等待时，在渲染期间直接对齐（React 推荐的「随 props 调整 state」写法），
  // 不先画一帧旧页面。
  if (route !== shown && !defer) setStage({ shown: route, swap: "direct" });
  const pending = route !== shown && defer ? route : null;

  useEffect(() => {
    if (pending === null) return;
    const timer = window.setTimeout(
      () => setStage({ shown: pending, swap: "timeout" }),
      ROUTE_HOLD_MS,
    );
    return () => window.clearTimeout(timer);
  }, [pending]);

  const onReady = useCallback(() => {
    if (pending !== null) setStage({ shown: pending, swap: "ready" });
  }, [pending]);
  const onCommand = useCallback(() => {
    if (pending !== null) setStage({ shown: pending, swap: "command" });
  }, [pending]);

  return (
    <>
      {/* data-swap 给测试看：快的读取应当是 ready，靠 timeout 换上说明就绪条件漏了或等不齐。 */}
      <div
        className="atm-route-layer"
        key={shown}
        data-swap={swap}
        data-leaving={pending === null ? undefined : "true"}
        inert={pending !== null}
      >
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
          {render(pending, { pending: true, onReady, onCommand })}
        </div>
      )}
    </>
  );
}

export type RouteStageSlot = {
  /** 还在后台准备、用户看不见。收到发给它的命令时应先调用 onCommand 换上来。 */
  pending: boolean;
  /** 首屏数据齐了（成功或失败都算）时调用一次。 */
  onReady: () => void;
  /** 用户在这一页上下了命令（例如「新建任务」）：不等数据，立刻换上。 */
  onCommand: () => void;
};

const noop = () => {};
const SHOWN: RouteStageSlot = { pending: false, onReady: noop, onCommand: noop };
