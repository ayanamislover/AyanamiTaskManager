import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AyanamiClient,
  DispatchEffort,
  DispatchPermissionMode,
  DispatchRunView,
  DispatchStatus,
} from "@ayanami-task/client";
import { useDialogs } from "../components/atm-dialogs.js";
import { AtmSelect } from "../components/atm-select.js";
import { LoadingRows, MutationErrorAlert, SectionLoadError } from "../components/async-state.js";
import type { DesktopBridge, Notify } from "../contracts.js";
import {
  CLAUDE_LOGIN_COMMAND,
  claudeReadiness,
  CONCURRENCY_OPTIONS,
  copyToClipboard,
  dispatchRefetchInterval,
  DISPATCH_STATUS_QUERY_KEY,
  dispatchOriginLabels,
  dispatchStateLabels,
  dispatchStateTone,
  EFFORT_OPTIONS,
  featureUnavailable,
  isActiveRun,
  modelInput,
  PERMISSION_MODES,
  resumeCommand,
  runWindow,
  shortSessionId,
} from "./mobile-sync-support.js";

/** 设置页「Claude 自动开工」：开关、权限模式、并发、模型与 effort，以及最近的派单。 */
export function DispatchPanel({
  client,
  desktop,
  notify,
}: {
  client: AyanamiClient;
  desktop?: DesktopBridge;
  notify: Notify;
}) {
  const status = useQuery({
    queryKey: DISPATCH_STATUS_QUERY_KEY,
    queryFn: () => client.getDispatchStatus(),
    refetchInterval: (query) =>
      featureUnavailable(query.state.error) ? false : dispatchRefetchInterval(query.state.data),
  });
  return (
    <section className="atm-panel atm-settings-dispatch" aria-labelledby="dispatch-panel-title">
      <div className="atm-panel-head">
        <h2 id="dispatch-panel-title">Claude 自动开工</h2>
      </div>
      <div className="atm-panel-body">
        {status.data ? (
          <div className="atm-dispatch-layout">
            <DispatchSettings
              client={client}
              status={status.data}
              notify={notify}
              {...(desktop ? { desktop } : {})}
            />
            <DispatchRuns
              client={client}
              runs={status.data.runs}
              notify={notify}
              {...(desktop ? { desktop } : {})}
            />
          </div>
        ) : status.error && featureUnavailable(status.error) ? (
          <p className="atm-sync-note">
            这个 ATM 宿主没有启用 Claude 派单（独立 daemon 或旧版本）。
          </p>
        ) : status.error && !status.isFetching ? (
          <SectionLoadError
            message="派单状态没能读出来，暂时无法显示或修改。"
            onRetry={() => void status.refetch()}
          />
        ) : (
          <LoadingRows count={3} />
        )}
      </div>
    </section>
  );
}

function DispatchSettings({
  client,
  status,
  desktop,
  notify,
}: {
  client: AyanamiClient;
  status: DispatchStatus;
  desktop?: DesktopBridge;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const dialogs = useDialogs();
  // 表单只在第一次拿到状态时取初值：状态每 5 秒刷新，不能冲掉还没保存的改动。
  const [mode, setMode] = useState<DispatchPermissionMode>(status.permissionMode);
  const [concurrency, setConcurrency] = useState(String(status.maxConcurrent));
  const [model, setModel] = useState(status.model ?? "");
  const [effort, setEffort] = useState<DispatchEffort | "">(status.effort ?? "");
  const parsedModel = modelInput(model);
  const dirty =
    mode !== status.permissionMode ||
    Number(concurrency) !== status.maxConcurrent ||
    parsedModel.model !== status.model ||
    (effort || null) !== status.effort;
  const refresh = () => queryClient.invalidateQueries({ queryKey: DISPATCH_STATUS_QUERY_KEY });
  const toggle = useMutation({
    mutationFn: () => client.updateDispatchConfig({ enabled: !status.enabled }),
    onSuccess: async () => {
      await refresh();
      notify(status.enabled ? "Claude 自动开工已关闭" : "Claude 自动开工已开启");
    },
  });
  const save = useMutation({
    mutationFn: () =>
      client.updateDispatchConfig({
        permissionMode: mode,
        maxConcurrent: Number(concurrency),
        model: parsedModel.model,
        effort: effort || null,
      }),
    onSuccess: async () => {
      await refresh();
      notify("自动开工设置已保存");
    },
  });
  const submit = async () => {
    if (parsedModel.problem) return;
    if (
      mode === "bypassPermissions" &&
      status.permissionMode !== "bypassPermissions" &&
      !(await dialogs.confirm({
        title: "跳过全部确认",
        message:
          "派出去的 Claude 会话将可以不经确认执行任何命令、改任何文件。只在你信任的仓库里这样设置。",
        confirmLabel: "仍然使用",
        tone: "danger",
      }))
    ) {
      return;
    }
    save.mutate();
  };
  const selectedMode = PERMISSION_MODES.find((entry) => entry.value === mode);
  const claude = claudeReadiness(status.claude);
  const copyLoginCommand = async () => {
    try {
      await copyToClipboard(desktop, CLAUDE_LOGIN_COMMAND);
      notify("命令已复制，到终端里粘贴运行");
    } catch (error) {
      notify(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return (
    <div className="atm-form">
      <p className="atm-row-sub atm-sync-intro">
        只处理你明确交给 Claude 的任务，不会自己挑任务。手机上勾选「交给
        Claude」或在任务详情里点「交给 Claude」后，ATM 在项目目录里拉起一个 Claude Code
        会话：领取任务、完善目标，然后开工。
      </p>
      <div className="atm-dispatch-rows">
        <div className="atm-row">
          <div>
            <div className="atm-row-title">自动开工</div>
            <div className="atm-row-sub">默认关闭；关闭后手机上的「交给 Claude」会被拒绝</div>
          </div>
          <button
            className="atm-button"
            type="button"
            aria-pressed={status.enabled}
            disabled={toggle.isPending}
            onClick={() => toggle.mutate()}
          >
            {toggle.isPending ? "正在切换" : status.enabled ? "已开启" : "已关闭"}
          </button>
        </div>
        <div className="atm-row">
          <div>
            <div className="atm-row-title">Claude Code</div>
            <div className="atm-row-sub" title={status.claude.path ?? undefined}>
              {claude.detail}
            </div>
          </div>
          <span className={`atm-badge ${claude.tone}`}>{claude.label}</span>
        </div>
      </div>
      {claude.needsLogin ? (
        <div className="atm-sync-note atm-claude-login" data-tone="warning">
          <p>
            Claude Code 未登录或登录已过期：在这台电脑的终端运行 <code>{CLAUDE_LOGIN_COMMAND}</code>
            ，派单才能开工
          </p>
          <button className="atm-button" type="button" onClick={() => void copyLoginCommand()}>
            复制命令
          </button>
        </div>
      ) : null}
      <div className="atm-dispatch-fields">
        <div className="atm-field">
          <label htmlFor="dispatch-permission-mode">权限模式</label>
          <AtmSelect
            id="dispatch-permission-mode"
            ariaLabel="权限模式"
            value={mode}
            options={PERMISSION_MODES.map(({ value, label }) => ({ value, label }))}
            onChange={(value) => setMode(value as DispatchPermissionMode)}
          />
        </div>
        <div className="atm-field">
          <label htmlFor="dispatch-concurrency">同时运行</label>
          <AtmSelect
            id="dispatch-concurrency"
            ariaLabel="同时运行的会话上限"
            value={concurrency}
            options={CONCURRENCY_OPTIONS}
            onChange={setConcurrency}
          />
        </div>
        <div className="atm-field">
          <label htmlFor="dispatch-model">模型</label>
          <input
            id="dispatch-model"
            autoComplete="off"
            spellCheck={false}
            placeholder="跟随 Claude Code 默认"
            aria-invalid={parsedModel.problem ? true : undefined}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          {parsedModel.problem ? (
            <small className="atm-field-problem" role="alert">
              {parsedModel.problem}
            </small>
          ) : null}
        </div>
        <div className="atm-field">
          <label htmlFor="dispatch-effort">Effort</label>
          <AtmSelect
            id="dispatch-effort"
            ariaLabel="Effort"
            value={effort}
            options={EFFORT_OPTIONS.map(({ value, label }) => ({ value, label }))}
            onChange={(value) => setEffort(value as DispatchEffort | "")}
          />
        </div>
      </div>
      {selectedMode ? (
        <p className="atm-sync-note" data-tone={selectedMode.risky ? "danger" : "info"}>
          {selectedMode.label}：{selectedMode.description}
        </p>
      ) : null}
      <MutationErrorAlert errors={[toggle.error, save.error]} />
      <div className="atm-sync-form-actions">
        <button
          className="atm-button primary"
          type="button"
          disabled={!dirty || Boolean(parsedModel.problem) || save.isPending}
          onClick={() => void submit()}
        >
          保存设置
        </button>
      </div>
    </div>
  );
}

function DispatchRuns({
  client,
  runs,
  desktop,
  notify,
}: {
  client: AyanamiClient;
  runs: DispatchRunView[];
  desktop?: DesktopBridge;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const dialogs = useDialogs();
  // 服务端确认进程已结束才回成功；没结束掉（DISPATCH_CANCEL_FAILED）时派单仍在运行、「结束」按钮还在，
  // 原因显示在列表上方，用户可以再点一次。无论成败都刷新列表：期间会话可能已经自己结束了。
  const cancel = useMutation({
    mutationFn: (run: string) => client.cancelDispatchRun(run),
    onSuccess: () => notify("派单已结束"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: DISPATCH_STATUS_QUERY_KEY }),
  });
  const confirmCancel = async (run: DispatchRunView) => {
    const confirmed = await dialogs.confirm({
      title: "结束这次派单",
      message: `会结束 ${run.key} 的 Claude 会话。已经写进 ATM 的进度会保留，之后仍可用 claude -r 接着这个会话。`,
      confirmLabel: "结束会话",
      tone: "danger",
    });
    if (confirmed) cancel.mutate(run.run);
  };
  const copy = async (sessionId: string) => {
    try {
      await copyToClipboard(desktop, sessionId);
      notify(`会话 ID 已复制；在项目目录运行 ${resumeCommand(sessionId)} 可以接着对话`);
    } catch (error) {
      notify(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const ordered = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return (
    <div className="atm-dispatch-runs">
      <div className="atm-sync-subhead">
        <h3>最近派单</h3>
        <span className="atm-badge">{runs.length}</span>
      </div>
      <MutationErrorAlert error={cancel.error} prefix="结束派单失败：" />
      {ordered.length ? (
        <div className="atm-list atm-scroll-list atm-dispatch-run-list">
          {ordered.map((run) => (
            <article className="atm-row atm-dispatch-run" key={run.run}>
              <div className="atm-dispatch-run-copy">
                <div className="atm-row-title" title={run.title}>
                  <span className="atm-key">{run.key}</span> {run.title}
                </div>
                <div className="atm-row-sub">
                  来自{dispatchOriginLabels[run.origin] ?? run.origin} · {runWindow(run)}
                </div>
                {run.summary?.result ? (
                  <div className="atm-row-sub atm-dispatch-summary">{run.summary.result}</div>
                ) : null}
                {run.error ? (
                  <div className="atm-row-sub atm-dispatch-error">{run.error}</div>
                ) : null}
                <div className="atm-row-sub" title={resumeCommand(run.sessionId)}>
                  会话 <code>{shortSessionId(run.sessionId)}</code> · 可用 claude -r 接着对话
                </div>
              </div>
              <div className="atm-dispatch-run-side">
                <span className={`atm-badge ${dispatchStateTone(run.state)}`}>
                  {dispatchStateLabels[run.state] ?? run.state}
                </span>
                <div className="atm-actions">
                  <button
                    className="atm-button"
                    type="button"
                    aria-label={`复制 ${run.key} 的会话 ID`}
                    onClick={() => void copy(run.sessionId)}
                  >
                    复制会话 ID
                  </button>
                  {isActiveRun(run) ? (
                    <button
                      className="atm-button danger"
                      type="button"
                      disabled={cancel.isPending}
                      onClick={() => void confirmCancel(run)}
                    >
                      结束
                    </button>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="atm-row-sub atm-sync-empty">
          还没有派单。在任务详情里点「交给 Claude」，或在手机上新建任务时勾选「交给 Claude」。
        </p>
      )}
    </div>
  );
}
