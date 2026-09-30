import { CloudSlashIcon as CloudSlash } from "@phosphor-icons/react/dist/icons/CloudSlash";
import { formatRelative } from "../data/time.js";
import { useEngine, useEngineState, useNow } from "./hooks.js";

/** 「刚刚」读作「刚才同步的数据」，其余读作「 N 分钟前同步的数据」。 */
export function staleLabel(syncedAt: string, now: number): string {
  const relative = formatRelative(syncedAt, now);
  return relative === "刚刚" ? "刚才" : ` ${relative}`;
}

/**
 * 项目页与任务详情顶部的离线提示：连不上中继时，页面上的「N 分钟前」「运行中」都是上次同步时的样子。
 * 形态与总览电脑状态卡里的 .host-alert 相同，只是单独成条。
 */
export function OfflineNote() {
  const engine = useEngine();
  const state = useEngineState();
  const now = useNow();
  if (state.phase !== "offline") return null;
  const { syncedAt } = state.snapshot;
  return (
    <div className="host-alert offline-note" role="status">
      <CloudSlash size={16} weight="bold" aria-hidden="true" />
      <span>
        离线中
        {syncedAt ? `，下面是${staleLabel(syncedAt, now)}同步的数据` : "，还没有同步过数据"}
      </span>
      <button type="button" className="text-button" onClick={() => engine.refresh()}>
        重试
      </button>
    </div>
  );
}
