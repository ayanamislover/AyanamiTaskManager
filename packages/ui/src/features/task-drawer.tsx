import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/dist/icons/CaretRight";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/icons/CheckCircle";
import type { WorkItemStatus } from "@ayanami-task/protocol";
import { checklistToggleIntent, evidenceText } from "../checklist-evidence.js";
import { ErrorState, LoadingRows } from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import { useCursorCollection } from "../cursor-collection.js";
import { useDialogAccessibility } from "../hooks/use-dialog-accessibility.js";
import { compactPath, progressSourceLabels, Status } from "../presentation.js";
import { workItemUiActions } from "../task-actions.js";
import { taskProgressPresentation } from "../task-progress.js";

export function TaskDrawer({
  client,
  project,
  taskKey,
  close,
  notify,
}: {
  client: AyanamiClient;
  project: string;
  taskKey: string;
  close: () => void;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useDialogAccessibility(close);
  // 正在为哪个检查项补证据；null 表示没有展开的输入框。
  const [evidenceDraft, setEvidenceDraft] = useState<{ id: string; text: string } | null>(null);
  const query = useQuery({
    queryKey: ["task", project, taskKey, "full"],
    queryFn: async () => {
      const [view, metadata] = await Promise.all([
        client.tasks.get(project, taskKey, "full"),
        client.tasks.getForUi(project, taskKey),
      ]);
      return { ...metadata, ...view };
    },
  });
  const engineering = useQuery({
    queryKey: ["engineering-metrics", project, taskKey],
    queryFn: () => client.projects.engineeringMetrics(project, taskKey),
  });
  const executionSessionCollection = useCursorCollection(
    ["task", project, taskKey, "execution-sessions"],
    (cursor) => client.projects.agentPage(project, 100, cursor),
  );
  const executionSessions = (executionSessionCollection.items as any[]).filter(
    (session) => session.currentTaskKey === taskKey,
  );
  const patch = useMutation({
    mutationFn: async (input: Record<string, unknown>) =>
      client.tasks.patchAsUser(project, {
        opId: `ui-patch-${crypto.randomUUID()}`,
        items: [{ taskKey, expectedVersion: Number(query.data!.version), ...input }],
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tasks", project] }),
        queryClient.invalidateQueries({ queryKey: ["task", project, taskKey] }),
        queryClient.invalidateQueries({ queryKey: ["reconciliation", project] }),
        queryClient.invalidateQueries({ queryKey: ["brief", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      notify("任务状态已更新");
    },
  });
  const check = useMutation({
    mutationFn: async (input: {
      item: any;
      status: "TODO" | "DONE" | "SKIPPED";
      evidence?: unknown[];
    }) =>
      client.tasks.checklistAsUser(project, input.item.id, {
        opId: `ui-check-${crypto.randomUUID()}`,
        checklistId: input.item.id,
        expectedVersion: input.item.version,
        status: input.status,
        evidence: input.evidence ?? input.item.evidence ?? [],
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["task", project, taskKey] }),
        queryClient.invalidateQueries({ queryKey: ["tasks", project] }),
        queryClient.invalidateQueries({ queryKey: ["reconciliation", project] }),
        queryClient.invalidateQueries({ queryKey: ["brief", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      setEvidenceDraft(null);
    },
    // 失败必须可见：证据闸门是最常见的拒绝原因，静默会让人以为勾选框坏了。
    onError: (error) =>
      notify(`检查项更新失败：${error instanceof Error ? error.message : String(error)}`),
  });
  const runAction = (operation: string) => {
    const input: Record<string, unknown> = { operation };
    if (operation === "block") {
      const reason = window.prompt("请填写阻塞原因");
      if (!reason?.trim()) return;
      input.blockedReason = reason.trim();
    }
    if (operation === "wait_user" || operation === "wait_agent") {
      const waitingFor = window.prompt(
        operation === "wait_user" ? "请填写等待用户提供的内容" : "请填写等待 Agent 完成的内容",
      );
      if (!waitingFor?.trim()) return;
      input.waitingFor = waitingFor.trim();
    }
    if (operation === "cancel" && !window.confirm("确认取消这个任务？")) return;
    patch.mutate(input);
  };
  const progress = query.data ? taskProgressPresentation(query.data) : null;
  return (
    <div className="atm-drawer-backdrop" role="presentation" onMouseDown={close}>
      <aside
        ref={dialogRef}
        className="atm-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="任务详情"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="atm-drawer-head">
          <button
            type="button"
            className="atm-drawer-collapse"
            onClick={close}
            aria-label="收起任务详情"
            title="收起任务详情"
          >
            <CaretRight size={18} weight="bold" aria-hidden="true" />
          </button>
          <div>
            {query.data ? (
              <>
                <span className="atm-key">{taskKey}</span>
                <h2 style={{ margin: "6px 0 0", fontSize: 19 }}>{String(query.data.title)}</h2>
              </>
            ) : (
              <span>载入任务</span>
            )}
          </div>
        </header>
        {query.isLoading ? (
          <LoadingRows />
        ) : query.error ? (
          <ErrorState error={query.error} />
        ) : (
          <div className="atm-drawer-body">
            <div className="atm-actions">
              <Status value={String(query.data!.status)} />
              {progress && progress.phaseLabel !== String(query.data!.status) ? (
                <span className="atm-badge">{progress.phaseLabel}</span>
              ) : null}
              {workItemUiActions({
                status: String(query.data!.status) as WorkItemStatus,
                actor: "USER",
                claimOwner:
                  typeof (query.data as Record<string, unknown>).assigneeAgentId === "string"
                    ? String((query.data as Record<string, unknown>).assigneeAgentId)
                    : null,
                claimStale: Boolean(
                  (query.data as Record<string, unknown>).claimLeaseUntil &&
                    Date.parse(String((query.data as Record<string, unknown>).claimLeaseUntil)) <=
                      Date.now(),
                ),
              }).map(({ operation, label }) => (
                <button
                  className={`atm-button ${["start", "verify", "complete"].includes(operation) ? "primary" : operation === "cancel" ? "danger" : ""}`}
                  disabled={patch.isPending}
                  key={operation}
                  onClick={() => runAction(operation)}
                >
                  {label}
                </button>
              ))}
            </div>
            {patch.error ? (
              <div className="atm-inline-error">
                {patch.error instanceof Error ? patch.error.message : String(patch.error)}
              </div>
            ) : null}
            <section className="atm-section">
              <h3>说明</h3>
              <div className="atm-description">
                {String(query.data!.description || "尚未填写说明")}
              </div>
            </section>
            <section className="atm-section">
              <h3>进度</h3>
              <div className="atm-progress">
                <span style={{ width: `${progress!.computed}%` }} />
              </div>
              <div className="atm-row-sub">
                派生 {Math.round(progress!.computed)}% ·{" "}
                {progressSourceLabels[progress!.source] ?? "状态计算"}
                {progress!.totalStages
                  ? ` · ${progress!.doneStages}/${progress!.totalStages} 阶段 · 权重 ${progress!.doneWeight}/${progress!.totalWeight}`
                  : ""}
              </div>
              {progress!.reported !== null && progress!.reported !== progress!.computed ? (
                <div className="atm-row-sub">Agent 报告：{Math.round(progress!.reported)}%</div>
              ) : null}
              {progress!.blocker ? (
                <div className="atm-inline-error">当前门禁：{progress!.blocker}</div>
              ) : null}
            </section>
            <section className="atm-section">
              <h3>执行 Session</h3>
              {executionSessionCollection.isLoading &&
              executionSessionCollection.loadedCount === 0 ? (
                <LoadingRows count={1} />
              ) : executionSessions.length ? (
                <div className="atm-list">
                  {executionSessions.map((session) => (
                    <article className="atm-row atm-execution-session" key={session.id}>
                      <div className="atm-execution-session-copy">
                        <div className="atm-row-title">
                          {session.displayName || session.agentId || "未命名 Agent"}
                        </div>
                        <div className="atm-row-sub">
                          <Status value={String(session.connectionState || "UNKNOWN")} /> · Git
                          branch：
                          <span title={session.git?.branch || ""}>
                            {session.git?.branch || "非 Git"}
                          </span>
                        </div>
                        <div className="atm-row-sub" title={session.git?.worktreeRoot || ""}>
                          Worktree：{compactPath(session.git?.worktreeRoot)}
                        </div>
                        <div className="atm-row-sub" title={session.git?.head || ""}>
                          HEAD：{String(session.git?.head || "不可用").slice(0, 12)}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : executionSessionCollection.error ? (
                <div className="atm-row-sub">执行 Session 暂时不可用，任务详情仍可继续使用。</div>
              ) : (
                <div className="atm-row-sub">当前没有领取此任务的 Session。</div>
              )}
            </section>
            <section className="atm-section">
              <h3>验收标准</h3>
              {(query.data!.acceptance as string[]).length ? (
                (query.data!.acceptance as string[]).map((item) => (
                  <div className="atm-check" key={item}>
                    <CheckCircle size={17} color="var(--atm-success)" />
                    <span>{item}</span>
                  </div>
                ))
              ) : (
                <div className="atm-row-sub">未设置验收标准</div>
              )}
            </section>
            <section className="atm-section">
              <h3>检查项</h3>
              {(query.data!.checklist as any[]).length ? (
                (query.data!.checklist as any[]).map((item) => {
                  const evidence: unknown[] = item.evidence ?? [];
                  const draft = evidenceDraft?.id === item.id ? evidenceDraft : null;
                  return (
                    <div className="atm-checkline" key={item.id}>
                      <label className="atm-check">
                        <input
                          type="checkbox"
                          checked={item.status === "DONE"}
                          disabled={check.isPending}
                          onChange={() => {
                            const intent = checklistToggleIntent(item);
                            if (intent.action === "request-evidence") {
                              setEvidenceDraft({ id: item.id, text: "" });
                              return;
                            }
                            check.mutate({ item, status: intent.status });
                          }}
                        />
                        <span>
                          {item.title}
                          {item.evidenceRequired ? (
                            <span className="atm-row-sub"> · 需要证据</span>
                          ) : null}
                          {item.status === "SKIPPED" ? (
                            <span className="atm-row-sub"> · 已跳过</span>
                          ) : null}
                        </span>
                      </label>
                      {evidence.length ? (
                        <ul className="atm-evidence">
                          {evidence.map((entry, index) => (
                            <li key={index}>{evidenceText(entry)}</li>
                          ))}
                        </ul>
                      ) : null}
                      {draft ? (
                        <div className="atm-field atm-evidence-form">
                          <label htmlFor={`evidence-${item.id}`}>证据</label>
                          <textarea
                            id={`evidence-${item.id}`}
                            value={draft.text}
                            autoFocus
                            placeholder="例如：packaged smoke 11/11，或 commit ab06501"
                            onChange={(event) =>
                              setEvidenceDraft({ id: item.id, text: event.target.value })
                            }
                          />
                          <div className="atm-actions">
                            <button
                              className="atm-button"
                              type="button"
                              disabled={!draft.text.trim() || check.isPending}
                              onClick={() =>
                                check.mutate({
                                  item,
                                  status: "DONE",
                                  evidence: [...evidence, draft.text.trim()],
                                })
                              }
                            >
                              附上并完成
                            </button>
                            <button
                              className="atm-button"
                              type="button"
                              onClick={() => setEvidenceDraft(null)}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="atm-actions atm-evidence-actions">
                          <button
                            className="atm-button"
                            type="button"
                            disabled={check.isPending}
                            onClick={() => setEvidenceDraft({ id: item.id, text: "" })}
                          >
                            添加证据
                          </button>
                          {item.status === "SKIPPED" ? (
                            <button
                              className="atm-button"
                              type="button"
                              disabled={check.isPending}
                              onClick={() => check.mutate({ item, status: "TODO" })}
                            >
                              恢复
                            </button>
                          ) : (
                            <button
                              className="atm-button"
                              type="button"
                              disabled={check.isPending}
                              onClick={() => check.mutate({ item, status: "SKIPPED" })}
                            >
                              跳过
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="atm-row-sub">未设置检查项</div>
              )}
            </section>
            <section className="atm-section">
              <h3>任务关系</h3>
              <div className="atm-actions">
                {query.data!.relations.length ? (
                  query.data!.relations.map((relation) => {
                    const label =
                      relation.type === "PARENT"
                        ? "父任务"
                        : relation.type === "CHILD"
                          ? "子任务"
                          : relation.type === "BLOCKS"
                            ? relation.direction === "INCOMING"
                              ? "依赖"
                              : "阻塞"
                            : relation.type === "DISCOVERED_FROM"
                              ? relation.direction === "OUTGOING"
                                ? "发现于"
                                : "发现"
                              : relation.type === "DUPLICATES"
                                ? "重复"
                                : "相关";
                    return (
                      <span
                        className={`atm-badge ${relation.type === "DISCOVERED_FROM" ? "primary" : ""}`}
                        key={`${relation.type}-${relation.direction}-${relation.taskKey}`}
                      >
                        {label} {relation.taskKey}
                      </span>
                    );
                  })
                ) : (
                  <span className="atm-row-sub">没有任务关系</span>
                )}
              </div>
            </section>
            {engineering.data?.available && engineering.data.workItem?.metrics ? (
              <section className="atm-section">
                <h3>工程变更</h3>
                <div className="atm-engineering-kpis compact">
                  <div>
                    <span>修改</span>
                    <strong>{engineering.data.workItem.metrics.filesChanged}</strong>
                  </div>
                  <div>
                    <span>新建</span>
                    <strong>{engineering.data.workItem.metrics.filesCreated}</strong>
                  </div>
                  <div>
                    <span>删除</span>
                    <strong>{engineering.data.workItem.metrics.filesDeleted}</strong>
                  </div>
                  <div>
                    <span>新增行</span>
                    <strong>+{engineering.data.workItem.metrics.linesAdded}</strong>
                  </div>
                  <div>
                    <span>删除行</span>
                    <strong>-{engineering.data.workItem.metrics.linesDeleted}</strong>
                  </div>
                  <div>
                    <span>净行数</span>
                    <strong>{engineering.data.workItem.metrics.netLines}</strong>
                  </div>
                  <div>
                    <span>Source +</span>
                    <strong>{engineering.data.workItem.metrics.sourceLinesAdded}</strong>
                  </div>
                  <div>
                    <span>Test +</span>
                    <strong>{engineering.data.workItem.metrics.testLinesAdded}</strong>
                  </div>
                </div>
                <div className="atm-row-sub">
                  新增依赖：
                  {(engineering.data.workItem.metrics.dependenciesAdded as string[]).join("、") ||
                    "无"}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </aside>
    </div>
  );
}
