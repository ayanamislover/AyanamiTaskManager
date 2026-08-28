import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderOpenIcon as FolderOpen } from "@phosphor-icons/react/dist/icons/FolderOpen";
import type { AyanamiClient, RegisteredProject } from "@ayanami-task/client";
import {
  findAgentSessionConflicts,
  groupAgentSessions,
  type AgentSessionLike,
} from "../agent-sessions.js";
import {
  CursorLoadStatus,
  Empty,
  ErrorState,
  LoadingRows,
  PageHead,
} from "../components/async-state.js";
import { useCursorCollections } from "../cursor-collection.js";
import { Status, compactPath, formatDuration, formatTime, statusLabels } from "../presentation.js";

export function AgentsPage({
  client,
  projects,
}: {
  client: AyanamiClient;
  projects: RegisteredProject[];
}) {
  const queryClient = useQueryClient();
  const agentSources = projects
    .filter((project) => project.lifecycle === "ACTIVE")
    .map((project) => ({
      key: project.code,
      loadPage: (cursor?: string) => client.projects.agentPage(project.code, 100, cursor),
    }));
  const collection = useCursorCollections(
    ["agents", "all", ...agentSources.map((source) => source.key)],
    agentSources,
  );
  const entries = Object.values(collection.entries);
  const loadedSessionCount = entries.reduce((total, entry) => total + entry.loadedCount, 0);
  const isLoading = entries.some((entry) => entry.isLoading);
  const errorEntry = entries.find((entry) => entry.error);
  const error = errorEntry?.error;
  const forceClose = useMutation({
    mutationFn: (session: any) =>
      client.sessions.forceClose(String(session.id), String(session.project), true),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agents"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
    },
  });
  const refreshGit = useMutation({
    mutationFn: (session: any) =>
      client.sessions.refreshGitContext(String(session.id), String(session.project)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
  if (isLoading && loadedSessionCount === 0)
    return (
      <>
        <PageHead title="Agent" description="项目内已注册的 Agent 会话和最近活动。" />
        <LoadingRows />
      </>
    );
  if (error && loadedSessionCount === 0)
    return (
      <>
        <PageHead title="Agent" description="项目内已注册的 Agent 会话和最近活动。" />
        <CursorLoadStatus
          loadedCount={loadedSessionCount}
          hasMore={false}
          error={error}
          onRetry={() => (errorEntry ? void collection.retry(errorEntry.key) : undefined)}
        />
        <ErrorState error={error} />
      </>
    );
  const allSessions = entries.flatMap((entry) =>
    entry.items.map((session) => ({ ...session, project: entry.key })),
  ) as AgentSessionLike[];
  const projectGroups = groupAgentSessions(allSessions);
  const conflicts = findAgentSessionConflicts(allSessions);
  return (
    <>
      <PageHead
        title="Agent"
        description="按项目与 Agent 身份聚合正式 Session；保留历史数量，并可关闭异常在线会话。"
      />
      {conflicts.length ? (
        <div className="atm-notice" role="status">
          {conflicts.map((conflict) => (
            <div key={`${conflict.kind}:${conflict.value}`}>
              ⚠ {conflict.count} 个活动 Session 正在使用同一
              {conflict.kind === "SAME_WORKTREE" ? " Worktree" : " Git branch"}：
              {compactPath(conflict.value)}
            </div>
          ))}
        </div>
      ) : null}
      <CursorLoadStatus
        loadedCount={loadedSessionCount}
        hasMore={entries.some((entry) => entry.hasMore)}
        loading={isLoading || entries.some((entry) => entry.isFetchingNextPage)}
        error={error}
        onRetry={() => {
          for (const entry of entries) {
            if (entry.error) void collection.retry(entry.key);
          }
        }}
      />
      <section className="atm-panel">
        {projectGroups.length === 0 ? (
          <Empty title="没有 Agent 会话" text="Agent 调用 atm_begin 后会在这里出现。" />
        ) : (
          <div className="agent-project-groups">
            {projectGroups.map((group) => (
              <details
                className="agent-project-group"
                data-agent-project={group.project}
                key={group.project}
                open
              >
                <summary className="agent-project-heading">
                  <span className="agent-project-title">
                    <FolderOpen size={18} aria-hidden="true" />
                    <span>{group.project}</span>
                  </span>
                  <span className="agent-project-stats">
                    <span>{group.agents.length} 个 Agent</span>
                    <span>{group.sessionCount} 个 Session</span>
                    <Status value={group.onlineCount ? "ONLINE" : "CLOSED"} />
                  </span>
                </summary>
                <div className="agent-session-grid">
                  {group.agents.map((session: any) => (
                    <article
                      className="agent-session-card"
                      data-agent-id={session.agentId}
                      key={`${session.project}:${session.agentId}`}
                    >
                      <header className="agent-session-card-header">
                        <div className="agent-session-identity">
                          <div className="atm-row-title">
                            {session.displayName || session.agentId || "未命名 Agent"}
                          </div>
                          <div className="atm-row-sub">
                            <span className="atm-key">{session.agentId}</span> ·{" "}
                            {session.sessionCount} 个 Session
                          </div>
                        </div>
                        <div className="agent-session-status">
                          <Status value={String(session.connectionState || "UNKNOWN")} />
                          <span className="atm-row-sub">{session.workState || "空闲"}</span>
                        </div>
                      </header>

                      <div className="agent-session-primary-grid">
                        <div className="agent-session-field">
                          <span>当前任务</span>
                          <strong>{session.currentTaskKey || "未领取"}</strong>
                        </div>
                        <div className="agent-session-field">
                          <span>角色</span>
                          <strong>{statusLabels[session.role] ?? session.role ?? "未知"}</strong>
                        </div>
                        <div className="agent-session-field">
                          <span>Git branch</span>
                          <strong title={session.git?.branch || ""}>
                            {session.git?.branch || "非 Git"}
                          </strong>
                        </div>
                        <div className="agent-session-field">
                          <span>Worktree</span>
                          <strong title={session.git?.worktreeRoot || ""}>
                            {compactPath(session.git?.worktreeRoot)}
                          </strong>
                        </div>
                      </div>

                      <details className="agent-session-audit">
                        <summary>
                          详细上下文与历史 <span className="atm-key">({session.sessionCount})</span>
                        </summary>
                        <div className="agent-session-detail-grid">
                          <div>
                            <span>当前 Session</span>
                            <strong>{session.id}</strong>
                          </div>
                          <div title={session.cwd || ""}>
                            <span>工作目录</span>
                            <strong>{compactPath(session.cwd)}</strong>
                          </div>
                          <div>
                            <span>HEAD</span>
                            <strong>{String(session.git?.head || "不可用").slice(0, 10)}</strong>
                          </div>
                          <div>
                            <span>Git 状态</span>
                            <strong>
                              {session.git?.available
                                ? session.git.dirty
                                  ? "dirty"
                                  : "clean"
                                : session.git?.error || "未观察"}
                            </strong>
                          </div>
                          <div>
                            <span>最后活动</span>
                            <strong>{formatTime(session.lastSeenAt)}</strong>
                          </div>
                          <div>
                            <span>持续时间</span>
                            <strong>{formatDuration(session.startedAt)}</strong>
                          </div>
                        </div>
                        {session.sessionHistory.length > 1 ? (
                          <div className="agent-session-history" aria-label="历史 Session">
                            <div className="agent-session-history-title">历史 Session</div>
                            {session.sessionHistory.map((history: any) => (
                              <div className="agent-session-history-row" key={history.id}>
                                <span className="atm-key">{history.id}</span>
                                <Status value={String(history.connectionState || "UNKNOWN")} />
                                <span>{formatTime(history.lastSeenAt)}</span>
                                {history.id === session.id ? (
                                  <span className="atm-row-sub">当前</span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </details>

                      <footer className="agent-session-actions">
                        <span className="atm-row-sub">
                          最近活动：{formatTime(session.lastSeenAt)}
                        </span>
                        <span className="atm-actions">
                          <button
                            className="atm-button"
                            disabled={refreshGit.isPending}
                            onClick={() => refreshGit.mutate(session)}
                          >
                            刷新 Git
                          </button>
                          {session.connectionState === "ONLINE" ? (
                            <button
                              className="atm-button danger"
                              disabled={forceClose.isPending}
                              onClick={() => {
                                if (window.confirm("关闭该异常 Session 并释放其任务领取？"))
                                  forceClose.mutate(session);
                              }}
                            >
                              关闭并释放
                            </button>
                          ) : null}
                        </span>
                      </footer>
                    </article>
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
      {forceClose.error ? (
        <div className="atm-inline-error" style={{ marginTop: 12 }}>
          {forceClose.error instanceof Error ? forceClose.error.message : String(forceClose.error)}
        </div>
      ) : null}
    </>
  );
}
