import type { SyncLogger, SyncSession } from "./session.js";
import { settlesWithin, withTimeout } from "./settings.js";

/** 停止预算用完、掐断中继请求后，再等在途任务落定的时间。 */
const ABORT_SETTLE_MS = 500;

/** 一轮同步循环：从连上配对空间到停下（停用、改连接设置、重置配对、退出）。 */
export type Loop = {
  /** 中断循环本身：长轮询、退避等待。 */
  controller: AbortController;
  /** 会话的全部中继请求（探测、发布、命令、在线状态）；停下收尾后或到预算时中止。 */
  relay: AbortController;
  /** 已停下：之后这个会话迟到的任务不能再碰 service 与派单（core 随后就会关库）。 */
  retired: boolean;
  promise: Promise<void>;
  session: SyncSession | null;
  /** 首次同步已完成，可以接受去抖发布与在线状态心跳。 */
  ready: boolean;
  /** 已经因为游标被拒（400）清过一次游标；再被拒就按普通错误处理。 */
  cursorRescued: boolean;
};

export function newLoop(): Loop {
  return {
    controller: new AbortController(),
    relay: new AbortController(),
    retired: false,
    promise: Promise.resolve(),
    session: null,
    ready: false,
    cursorRescued: false,
  };
}

/** 会话作废：在途中继请求立即失败，迟到的任务不再碰 service 与派单。 */
export function retireLoop(loop: Loop): void {
  loop.retired = true;
  loop.relay.abort();
}

export type HaltOptions = {
  /** 对中继写操作的串行链（连接器的 #chain）：停下前等它收尾。 */
  chain: Promise<unknown>;
  /** 整个停止过程的预算（stopTimeoutMs）。 */
  budgetMs: number;
  /** 收尾后是否写离线状态（停用、退出时写；重置配对不写）。 */
  offline: boolean;
  logger: SyncLogger;
  describe(error: unknown): string;
};

/**
 * 停下一轮循环：中断长轮询与退避，等在途的中继写操作收尾，再写离线状态。整个过程共用一个预算：
 * 原生宿主只给 core 有限的退出时间（8 s），到点还没收尾就掐断这个会话的全部中继请求，
 * 不再写离线状态（中继已经不响应，写也只会再卡一次）。返回时会话已作废。
 */
export async function haltLoop(loop: Loop, options: HaltOptions): Promise<void> {
  const deadline = Date.now() + options.budgetMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  loop.controller.abort();
  // 会话还没建起来（还在探测中继）：没有离线状态可写，直接掐断。
  if (!loop.session) loop.relay.abort();
  const inFlight = Promise.all([loop.promise, options.chain]);
  if (!(await settlesWithin(inFlight, remaining()))) {
    options.logger.warn("停止时中继迟迟没有响应，已中断在途请求");
    retireLoop(loop);
    await settlesWithin(inFlight, ABORT_SETTLE_MS);
    return;
  }
  if (options.offline && loop.session && loop.ready && remaining() > 0) {
    try {
      await withTimeout(loop.session.writePresence("offline"), remaining());
    } catch (error) {
      options.logger.warn("写离线状态失败", { error: options.describe(error) });
    }
  }
  retireLoop(loop);
}
