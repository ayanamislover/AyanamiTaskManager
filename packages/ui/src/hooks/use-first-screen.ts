import { useEffect, useRef, useState } from "react";

/** 首屏最多等这么久；还有来源没读完就先把已就绪的部分换上，剩下的在原地显示读取状态。 */
export const FIRST_SCREEN_MAX_WAIT_MS = 1_500;

/**
 * 页面首屏要不要换上：数据齐了（ready）或者等满时限就换上，而且只卡这一次。
 *
 * 换上之后再有来源回到加载态——点「重试」重读一个失败的项目、新建了项目多出一个来源——
 * 页面都保持已显示的内容，只在局部显示读取状态，不退回整页骨架。
 * 以前用「现在有没有来源在加载」直接决定显示骨架，重试一个项目就把其他项目的行全藏掉。
 */
export function useFirstScreen(ready: boolean, maxWaitMs = FIRST_SCREEN_MAX_WAIT_MS): boolean {
  const shown = useRef(false);
  const [waitedOut, setWaitedOut] = useState(false);
  if (ready || waitedOut) shown.current = true;
  const settled = shown.current;
  useEffect(() => {
    if (settled) return;
    const timer = window.setTimeout(() => setWaitedOut(true), maxWaitMs);
    return () => window.clearTimeout(timer);
  }, [settled, maxWaitMs]);
  return settled;
}
