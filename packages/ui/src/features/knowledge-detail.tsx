import { ArchiveIcon as Archive } from "@phosphor-icons/react/dist/icons/Archive";
import { ArrowCounterClockwiseIcon as Restore } from "@phosphor-icons/react/dist/icons/ArrowCounterClockwise";
import { ClockCounterClockwiseIcon as History } from "@phosphor-icons/react/dist/icons/ClockCounterClockwise";
import { PencilSimpleIcon as Pencil } from "@phosphor-icons/react/dist/icons/PencilSimple";
import type { KnowledgeEntry, KnowledgeRevision } from "@ayanami-task/client";
import { LoadingRows, MutationErrorAlert } from "../components/async-state.js";
import { displayList, sourceLabel } from "./knowledge-support.js";
import { formatTime } from "../presentation.js";

export function KnowledgeDetail({
  entry,
  showHistory,
  history,
  historyLoading,
  historyLoadingMore,
  historyHasMore,
  historyError,
  onEdit,
  onArchive,
  onCopyReference,
  onToggleHistory,
  onLoadMoreHistory,
  onLoadRevision,
  archivePending,
  archiveError,
  notice,
}: {
  entry: KnowledgeEntry & { toc?: Array<{ id: string; title: string; level: number }> };
  showHistory: boolean;
  history: Array<Omit<KnowledgeRevision, "bodyMarkdown">>;
  historyLoading: boolean;
  historyLoadingMore: boolean;
  historyHasMore: boolean;
  historyError: unknown;
  onEdit: () => void;
  onArchive: () => void;
  onCopyReference: () => void | Promise<void>;
  onToggleHistory: () => void;
  onLoadMoreHistory: () => void | Promise<void>;
  onLoadRevision: (revisionId: string) => void | Promise<void>;
  archivePending: boolean;
  archiveError: unknown;
  notice: string;
}) {
  return (
    <>
      <div className="atm-panel-head atm-knowledge-detail-head">
        <div>
          <div className="atm-knowledge-detail-kicker">
            <span className="atm-key">{entry.slug}</span>
            <span className={`atm-badge ${entry.archived ? "warning" : "success"}`}>
              {entry.archived ? "已归档" : "已发布"}
            </span>
          </div>
          <h2>{entry.title}</h2>
          <div className="atm-row-sub">
            修订 v{entry.revision} · 更新于 {formatTime(entry.createdAt)}
          </div>
        </div>
        <div className="atm-actions">
          <button className="atm-button" type="button" onClick={onEdit}>
            <Pencil size={16} />
            编辑
          </button>
          <button className="atm-button" type="button" onClick={() => void onCopyReference()}>
            复制引用
          </button>
          <button className="atm-button" type="button" onClick={onToggleHistory}>
            <History size={16} />
            {showHistory ? "收起历史" : "修订历史"}
          </button>
          <button
            className={`atm-button ${entry.archived ? "" : "danger"}`}
            type="button"
            disabled={archivePending}
            onClick={onArchive}
          >
            {entry.archived ? <Restore size={16} /> : <Archive size={16} />}
            {entry.archived ? "恢复条目" : "归档条目"}
          </button>
        </div>
      </div>
      <div className="atm-panel-body atm-knowledge-detail-body">
        {notice ? (
          <div className="atm-inline-warning" role="status">
            {notice}
          </div>
        ) : null}
        <div className="atm-knowledge-summary-grid">
          <div>
            <div className="atm-row-title">摘要</div>
            <p>{entry.summary}</p>
          </div>
          <div>
            <div className="atm-row-title">使用场景</div>
            <p>{entry.useWhen || "未填写"}</p>
          </div>
        </div>
        <div className="atm-knowledge-meta-grid">
          <div>
            <span>标签</span>
            <strong>{displayList(entry.tags) || "无"}</strong>
          </div>
          <div>
            <span>适用范围</span>
            <strong>{displayList(entry.appliesTo) || "未填写"}</strong>
          </div>
          <div>
            <span>别名</span>
            <strong>{displayList(entry.aliases) || "无"}</strong>
          </div>
        </div>
        {entry.sourceRefs.length ? (
          <div className="atm-knowledge-sources">
            <div className="atm-row-title">来源引用</div>
            {entry.sourceRefs.map((source) => (
              <div className="atm-row-sub" key={`${source.type}:${source.reference}`}>
                {sourceLabel(source)}
              </div>
            ))}
          </div>
        ) : null}
        {entry.toc?.length ? (
          <details className="atm-knowledge-toc">
            <summary>章节目录（{entry.toc.length}）</summary>
            <div>
              {entry.toc.map((heading) => (
                <div key={heading.id} style={{ paddingLeft: Math.max(0, heading.level - 1) * 14 }}>
                  {heading.title}
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <pre className="atm-knowledge-markdown">{entry.bodyMarkdown}</pre>
        {showHistory ? (
          <section className="atm-knowledge-history">
            <h3>修订历史</h3>
            {historyLoading ? <LoadingRows count={2} /> : null}
            {historyError ? <MutationErrorAlert error={historyError} /> : null}
            {!historyLoading && !historyError && !history.length ? (
              <div className="atm-row-sub">暂无更早修订。</div>
            ) : null}
            {history.map((revision) => (
              <div className="atm-knowledge-history-row" key={revision.revision}>
                <div>
                  <strong>
                    v{revision.revision} · {revision.title}
                  </strong>
                  <span>
                    {revision.summary} · {formatTime(revision.createdAt)}
                  </span>
                </div>
                <button
                  className="atm-button"
                  type="button"
                  onClick={() => void onLoadRevision(revision.revisionId)}
                >
                  载入为新修订
                </button>
              </div>
            ))}
            {historyHasMore ? (
              <button
                className="atm-button"
                type="button"
                disabled={historyLoadingMore}
                onClick={() => void onLoadMoreHistory()}
              >
                {historyLoadingMore ? "加载更早修订中…" : "加载更早修订"}
              </button>
            ) : null}
          </section>
        ) : null}
        <MutationErrorAlert error={archiveError} />
      </div>
    </>
  );
}
