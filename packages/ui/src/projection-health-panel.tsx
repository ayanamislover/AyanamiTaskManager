import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import type {
  ProjectionFailureView,
  ProjectionStateView,
  ProjectionSummary,
} from "@ayanami-task/protocol";
import { MutationErrorAlert } from "./components/async-state.js";

export async function invalidateProjectionQueries(
  queryClient: Pick<QueryClient, "invalidateQueries">,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["overview"] }),
    queryClient.invalidateQueries({ queryKey: ["status"] }),
  ]);
}

export function ProjectionStatusBadge({ status }: { status: "APPLIED" | "DEFERRED" | "MISSING" }) {
  return (
    <span
      className={`atm-badge ${
        status === "APPLIED" ? "success" : status === "DEFERRED" ? "warning" : "danger"
      }`}
    >
      {status === "APPLIED" ? "已追平" : status === "DEFERRED" ? "等待重试" : "状态缺失"}
    </span>
  );
}

function ProjectionError({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="atm-inline-error atm-projection-error" role="status" title={error}>
      {error}
    </div>
  );
}

export function ProjectProjectionPanel({
  client,
  projectCode,
  state,
  notify,
}: {
  client: AyanamiClient;
  projectCode: string;
  state: ProjectionStateView | null;
  notify?: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const reconcile = useMutation({
    mutationFn: () => client.projects.reconcileProjection(projectCode),
    onSuccess: async (receipt) => {
      await invalidateProjectionQueries(queryClient);
      notify?.(
        receipt.projection.status === "APPLIED"
          ? `${projectCode} 数据投影已追平`
          : `${projectCode} 数据投影仍在等待重试`,
      );
    },
  });
  const mutationError = reconcile.error;
  const latest = reconcile.data?.projection ?? state;

  return (
    <section className="atm-panel atm-projection-panel" aria-label="数据投影">
      <div className="atm-panel-head">
        <div>
          <h2>数据投影</h2>
          <div className="atm-row-sub">将项目权威数据同步到全局检索与摘要</div>
        </div>
        <div className="atm-actions">
          <ProjectionStatusBadge status={latest?.status ?? "MISSING"} />
          <button
            type="button"
            className="atm-button"
            disabled={reconcile.isPending}
            onClick={() => reconcile.mutate()}
          >
            {reconcile.isPending ? "正在重试" : "立即重试"}
          </button>
        </div>
      </div>
      <div className="atm-panel-body atm-projection-body">
        <div className="atm-row">
          <div>
            <div className="atm-row-title">同步序列</div>
            <div className="atm-row-sub">
              源 {latest?.sourceSeq ?? "—"} · 已投影 {latest?.projectedSeq ?? "—"}
            </div>
          </div>
          <span className="atm-key">lag {latest?.lag ?? "—"}</span>
        </div>
        <div className="atm-row">
          <div>
            <div className="atm-row-title">重试状态</div>
            <div className="atm-row-sub">
              累计 {latest?.retryCount ?? 0} 次 · 状态更新 {state?.updatedAt ?? "尚无状态"}
            </div>
          </div>
          {reconcile.data ? (
            <span className="atm-key" title={reconcile.data.attemptedAt}>
              已尝试
            </span>
          ) : null}
        </div>
        <MutationErrorAlert error={mutationError} className="atm-projection-error" />
        {!mutationError ? <ProjectionError error={latest?.lastError} /> : null}
      </div>
    </section>
  );
}

export function SystemProjectionPanel({
  client,
  summary,
  failures,
  notify,
}: {
  client: AyanamiClient;
  summary: ProjectionSummary;
  failures: ProjectionFailureView[];
  notify?: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const reconcile = useMutation({
    mutationFn: () => client.projections.reconcileAll(),
    onSuccess: async (receipt) => {
      await invalidateProjectionQueries(queryClient);
      notify?.(
        receipt.deferred || receipt.failed
          ? `投影重试完成：${receipt.applied} 已追平，${receipt.deferred + receipt.failed} 仍需处理`
          : `全部 ${receipt.applied} 个项目投影已追平`,
      );
    },
  });
  return (
    <section className="atm-panel atm-projection-panel" aria-label="全局投影状态">
      <div className="atm-panel-head">
        <div>
          <h2>全局投影状态</h2>
          <div className="atm-row-sub">项目间独立重试，延迟不会回滚权威写入</div>
        </div>
        <div className="atm-actions">
          <ProjectionStatusBadge status={summary.status} />
          <button
            type="button"
            className="atm-button"
            disabled={reconcile.isPending}
            onClick={() => reconcile.mutate()}
          >
            {reconcile.isPending ? "正在重试" : "重试全部"}
          </button>
        </div>
      </div>
      <div className="atm-panel-body atm-projection-body">
        <div className="atm-project-stats">
          <span>已追平 {summary.appliedCount}</span>
          <span>待重试 {summary.deferredCount}</span>
          <span>状态缺失 {summary.missingCount}</span>
          <span>最大 lag {summary.maxLag}</span>
        </div>
        {failures.map((failure) => (
          <div className="atm-projection-failure" key={failure.project.id}>
            <div className="atm-row">
              <div>
                <div className="atm-row-title">
                  {failure.project.code} · {failure.project.name}
                </div>
                <div className="atm-row-sub">
                  {failure.reason === "MISSING"
                    ? "投影状态缺失"
                    : failure.reason === "INVERTED"
                      ? `序列倒挂 · lag ${failure.lag}`
                      : `等待重试 · lag ${failure.lag}`}
                </div>
              </div>
              <ProjectionStatusBadge
                status={failure.reason === "MISSING" ? "MISSING" : "DEFERRED"}
              />
            </div>
            {failure.lastError ? <ProjectionError error={failure.lastError} /> : null}
          </div>
        ))}
        <MutationErrorAlert error={reconcile.error} className="atm-projection-error" />
      </div>
    </section>
  );
}
