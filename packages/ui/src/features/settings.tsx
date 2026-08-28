import { Fragment, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { Empty, ErrorState, LoadingRows, PageHead } from "../components/async-state.js";
import type {
  AgentIntegrationAction,
  DesktopBridge,
  McpClient,
  NotificationMode,
} from "../contracts.js";
import { McpBridgePanel } from "../mcp-bridge-panel.js";
import {
  AgentIntegrationBadge,
  Status,
  agentClientLabel,
  formatTime,
  integrationState,
} from "../presentation.js";
import { SystemProjectionPanel } from "../projection-health-panel.js";
import { NotificationPolicy } from "./settings-panels.js";

export function SettingsPage({
  client,
  desktop,
}: {
  client: AyanamiClient;
  desktop?: DesktopBridge;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["status"], queryFn: () => client.status() });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => client.settings.list() });
  const configs = useQuery({
    queryKey: ["mcp-configs"],
    queryFn: () => desktop!.getMcpConfigs!(),
    enabled: Boolean(desktop?.getMcpConfigs),
  });
  const integrations = useQuery({
    queryKey: ["agent-integrations"],
    queryFn: () => desktop!.getAgentIntegrations!(),
    enabled: Boolean(desktop?.getAgentIntegrations),
  });
  const updateStatus = useQuery({
    queryKey: ["desktop-update-status"],
    queryFn: () => desktop!.getUpdateStatus!(),
    enabled: Boolean(desktop?.getUpdateStatus),
    refetchInterval: 30_000,
  });
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
  const [memoryProfile, setMemoryProfile] = useState<boolean | null>(null);
  const [memoryProfilePending, setMemoryProfilePending] = useState(false);
  const [memoryProfileError, setMemoryProfileError] = useState("");
  const [memoryProfileNotice, setMemoryProfileNotice] = useState("");
  const [dailyEnabled, setDailyEnabled] = useState(true);
  const [dailyKeep, setDailyKeep] = useState(7);
  const [weeklyKeep, setWeeklyKeep] = useState(4);
  const [notificationMode, setNotificationMode] = useState<NotificationMode>("ALL");
  const [feedback, setFeedback] = useState("");
  const [integrationPreview, setIntegrationPreview] = useState<{
    client: McpClient;
    current: string;
    proposed: string;
  } | null>(null);
  useEffect(() => {
    void desktop?.getAutoLaunch?.().then(setAutoLaunch);
  }, [desktop]);
  useEffect(() => {
    void desktop
      ?.getMemoryProfile?.()
      .then(setMemoryProfile)
      .catch((error: unknown) => {
        setMemoryProfileError(error instanceof Error ? error.message : String(error));
      });
  }, [desktop]);
  useEffect(() => {
    if (!settings.data) return;
    const backup = settings.data.find((entry) => entry.key === "backup.policy")?.value as any;
    const notification = settings.data.find((entry) => entry.key === "notification.mode")?.value;
    const legacyNotification = settings.data.find(
      (entry) => entry.key === "notification.enabled",
    )?.value;
    if (backup) {
      setDailyEnabled(backup.enabled !== false);
      setDailyKeep(Number(backup.dailyKeep ?? 7));
      setWeeklyKeep(Number(backup.weeklyKeep ?? 4));
    }
    if (["ALL", "CRITICAL", "OFF"].includes(String(notification))) {
      setNotificationMode(notification as NotificationMode);
    } else if (legacyNotification === false) {
      setNotificationMode("OFF");
    }
  }, [settings.data]);
  const savePolicy = useMutation({
    mutationFn: async () => {
      const backup = settings.data?.find((entry) => entry.key === "backup.policy");
      const notification = settings.data?.find((entry) => entry.key === "notification.mode");
      const legacyNotification = settings.data?.find(
        (entry) => entry.key === "notification.enabled",
      );
      await client.settings.put(
        "backup.policy",
        { enabled: dailyEnabled, dailyKeep, weeklyKeep },
        Number(backup?.version ?? -1),
      );
      await client.settings.put(
        "notification.mode",
        notificationMode,
        Number(notification?.version ?? -1),
      );
      await client.settings.put(
        "notification.enabled",
        notificationMode !== "OFF",
        Number(legacyNotification?.version ?? -1),
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      setFeedback("设置已保存");
    },
  });
  const manageIntegration = useMutation({
    mutationFn: ({ client, action }: { client: McpClient; action: AgentIntegrationAction }) =>
      desktop!.manageAgentIntegration!(client, action),
    onSuccess: async (result, variables) => {
      if (result.preview) {
        setIntegrationPreview({ client: variables.client, ...result.preview });
        setFeedback(`${agentClientLabel(variables.client)} 修改预览已生成`);
        return;
      }
      setIntegrationPreview(null);
      await queryClient.invalidateQueries({ queryKey: ["agent-integrations"] });
      setFeedback(
        `${agentClientLabel(variables.client)} Agent 接入已${
          variables.action === "UNINSTALL" ? "卸载" : "更新"
        }`,
      );
    },
  });
  const checkUpdate = useMutation({
    mutationFn: () => desktop!.checkForUpdates!(),
    onSuccess: (status) => {
      queryClient.setQueryData(["desktop-update-status"], status);
      setFeedback(status?.message ?? "更新检查已启动");
    },
  });
  const copy = async (text: string, label: string) => {
    if (desktop?.copyText) await desktop.copyText(text);
    else await navigator.clipboard.writeText(text);
    setFeedback(`${label}已复制`);
  };
  return (
    <>
      <PageHead title="设置" description="本地服务、Agent 接入、自动备份和 Windows 启动行为。" />
      <div className="atm-settings-grid">
        <section className="atm-panel">
          <div className="atm-panel-head">
            <h2>服务与数据库</h2>
          </div>
          {query.isLoading ? (
            <LoadingRows />
          ) : query.error ? (
            <ErrorState error={query.error} />
          ) : (
            <div className="atm-panel-body atm-form">
              <div className="atm-row">
                <div>
                  <div className="atm-row-title">本地服务</div>
                  <div className="atm-row-sub">仅绑定 127.0.0.1，并要求本地令牌</div>
                </div>
                <Status value={query.data!.ok ? "ACTIVE" : "MIGRATION_FAILED"} />
              </div>
              <div className="atm-row">
                <div>
                  <div className="atm-row-title">SQLite</div>
                  <div className="atm-row-sub">
                    FTS5 {String((query.data!.sqlite as any)?.fts5)} · trigram{" "}
                    {String((query.data!.sqlite as any)?.trigram)} · WAL{" "}
                    {String((query.data!.sqlite as any)?.wal)}
                  </div>
                </div>
                <span className="atm-key">
                  {String((query.data!.sqlite as any)?.sqliteVersion ?? "")}
                </span>
              </div>
              <div className="atm-row">
                <div>
                  <div className="atm-row-title">项目数据库</div>
                  <div className="atm-row-sub">独立文件并通过 quick_check</div>
                </div>
                <span className="atm-key">{String(query.data!.projectCount)}</span>
              </div>
            </div>
          )}
        </section>
        {query.data ? (
          <SystemProjectionPanel
            client={client}
            summary={query.data.projectionSummary}
            failures={query.data.projectionFailures}
            notify={setFeedback}
          />
        ) : null}
        <section className="atm-panel">
          <div className="atm-panel-head">
            <h2>Agent 接入</h2>
          </div>
          <div className="atm-panel-body atm-form">
            {desktop?.getMcpConfigs ? (
              <>
                {configs.isLoading ? (
                  <LoadingRows count={3} />
                ) : configs.error ? (
                  <ErrorState error={configs.error} />
                ) : (
                  <>
                    <div className="atm-row-sub">
                      只管理 ATM 的 MCP、全局规则 block 与两个 Skill；写入前备份，不覆盖其他内容。
                    </div>
                    {desktop?.setMemoryProfile ? (
                      <div className="atm-row" data-testid="memory-profile-toggle">
                        <div>
                          <div className="atm-row-title">完整工具面（memory + actions）</div>
                          <div className="atm-row-sub">
                            默认开启完整工具面。关闭会同时移除 memory 与 actions 两个静态
                            Profile，只保留 core，但关闭后将失去
                            atm_task_patch、atm_progress_add、atm_record、atm_search、atm_delta
                            五个工具。切换后请重载或重启 Agent 客户端。
                          </div>
                          {memoryProfileError ? (
                            <div className="atm-inline-error" role="alert">
                              切换失败，偏好未保存：{memoryProfileError}
                            </div>
                          ) : memoryProfileNotice ? (
                            <div className="atm-row-sub" role="status">
                              {memoryProfileNotice}
                            </div>
                          ) : null}
                        </div>
                        <button
                          className="atm-button"
                          disabled={memoryProfile === null || memoryProfilePending}
                          onClick={async () => {
                            setMemoryProfilePending(true);
                            setMemoryProfileError("");
                            setMemoryProfileNotice("");
                            try {
                              const result = await desktop.setMemoryProfile!(!memoryProfile);
                              setMemoryProfile(result.enabled);
                              const updated = result.clients.filter(
                                (entry) => entry.status === "UPDATED",
                              ).length;
                              setMemoryProfileNotice(
                                `已同步 ${updated} 个 Agent 配置；请重载或重启客户端生效。`,
                              );
                              // 开关改的是「该装哪些 server」，已安装状态与可复制的配置文本
                              // 都跟着变，两个都要重新取，否则界面停在改之前的样子。
                              await queryClient.invalidateQueries({
                                queryKey: ["agent-integrations"],
                              });
                              await queryClient.invalidateQueries({ queryKey: ["mcp-configs"] });
                            } catch (error) {
                              setMemoryProfileError(
                                error instanceof Error ? error.message : String(error),
                              );
                            } finally {
                              setMemoryProfilePending(false);
                            }
                          }}
                        >
                          {memoryProfilePending ? "正在同步" : memoryProfile ? "已开启" : "已关闭"}
                        </button>
                      </div>
                    ) : null}
                    {integrations.isLoading ? (
                      <LoadingRows count={2} />
                    ) : integrations.data ? (
                      <div className="atm-integration-list">
                        {integrations.data.map((report) => {
                          const overall = integrationState(report);
                          const primaryAction: AgentIntegrationAction =
                            overall === "MODIFIED"
                              ? "REPAIR"
                              : overall === "NEEDS_UPDATE"
                                ? "UPDATE"
                                : "INSTALL";
                          const primaryLabel =
                            primaryAction === "REPAIR"
                              ? "修复"
                              : primaryAction === "UPDATE"
                                ? "更新"
                                : "安装";
                          const cliUnavailable =
                            report.client === "CLAUDE_CODE" && !report.cliAvailable;
                          const installNeedsCli = cliUnavailable && !report.mcpInstalled;
                          return (
                            <article className="atm-integration-card" key={report.client}>
                              <header>
                                <strong>{agentClientLabel(report.client)}</strong>
                                <AgentIntegrationBadge state={overall} />
                              </header>
                              <div className="atm-integration-checks">
                                <span>MCP</span>
                                <AgentIntegrationBadge
                                  state={report.mcpInstalled ? "INSTALLED" : "NOT_INSTALLED"}
                                />
                                {report.sharesRuleAndSkillsWith ? (
                                  <>
                                    <span>规则/技能</span>
                                    <span className="atm-row-sub">与 Claude Desktop 共用</span>
                                  </>
                                ) : (
                                  <>
                                    <span>全局 ATM 规则</span>
                                    <AgentIntegrationBadge state={report.rule.state} />
                                    {report.skills.skills.map((skill) => (
                                      <Fragment key={skill.name}>
                                        <span>{skill.name}</span>
                                        <AgentIntegrationBadge state={skill.state} />
                                      </Fragment>
                                    ))}
                                  </>
                                )}
                                {cliUnavailable ? (
                                  <>
                                    <span>CLI</span>
                                    <span className="atm-row-sub">未检测到，安装/卸载不可用</span>
                                  </>
                                ) : null}
                              </div>
                              {report.repairError ? (
                                <div className="atm-inline-error" role="alert">
                                  自动修复失败：{report.repairError}
                                </div>
                              ) : null}
                              <div className="atm-actions">
                                <button
                                  className="atm-button"
                                  disabled={manageIntegration.isPending}
                                  onClick={() =>
                                    manageIntegration.mutate({
                                      client: report.client,
                                      action: "PREVIEW",
                                    })
                                  }
                                >
                                  预览修改
                                </button>
                                {overall !== "INSTALLED" ? (
                                  <button
                                    className="atm-button primary"
                                    disabled={manageIntegration.isPending || installNeedsCli}
                                    onClick={() =>
                                      manageIntegration.mutate({
                                        client: report.client,
                                        action: primaryAction,
                                      })
                                    }
                                  >
                                    {primaryLabel}
                                  </button>
                                ) : null}
                                {overall !== "NOT_INSTALLED" ? (
                                  <button
                                    className="atm-button danger"
                                    disabled={manageIntegration.isPending || cliUnavailable}
                                    onClick={() =>
                                      manageIntegration.mutate({
                                        client: report.client,
                                        action: "UNINSTALL",
                                      })
                                    }
                                  >
                                    卸载 ATM 接入
                                  </button>
                                ) : null}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    ) : null}
                    {integrationPreview ? (
                      <details className="atm-integration-preview" open>
                        <summary>
                          {agentClientLabel(integrationPreview.client)} 规则修改预览
                        </summary>
                        <pre>{integrationPreview.proposed}</pre>
                      </details>
                    ) : null}
                    <div className="atm-actions">
                      <button
                        className="atm-button"
                        onClick={() =>
                          void copy(configs.data!.streamableHttp, "Streamable HTTP 配置")
                        }
                      >
                        复制 Streamable HTTP
                      </button>
                      <button
                        className="atm-button"
                        onClick={() => void copy(configs.data!.stdio, "stdio 配置")}
                      >
                        复制 stdio
                      </button>
                      <button
                        className="atm-button"
                        onClick={() => void copy(configs.data!.generic, "通用 MCP 配置")}
                      >
                        生成通用配置
                      </button>
                      <button
                        className="atm-button"
                        onClick={async () => {
                          await client.status();
                          setFeedback("连接测试通过");
                        }}
                      >
                        运行连接测试
                      </button>
                    </div>
                    <button
                      className="atm-button"
                      onClick={() => void copy(configs.data!.agentRule, "Agent 最短规则")}
                    >
                      复制 Agent 最短规则
                    </button>
                  </>
                )}
              </>
            ) : (
              <Empty title="浏览器预览模式" text="Agent 自动安装仅在桌面应用内可用。" />
            )}
            {manageIntegration.error ? (
              <div className="atm-inline-error">
                {manageIntegration.error instanceof Error
                  ? manageIntegration.error.message
                  : String(manageIntegration.error)}
              </div>
            ) : null}
          </div>
        </section>
        {desktop?.getMcpBridges ? <McpBridgePanel load={desktop.getMcpBridges} /> : null}
        <section className="atm-panel">
          <div className="atm-panel-head">
            <h2>维护与 Windows</h2>
          </div>
          <div className="atm-panel-body atm-form">
            <label className="atm-check">
              <input
                type="checkbox"
                checked={dailyEnabled}
                onChange={(event) => setDailyEnabled(event.target.checked)}
              />
              <span>每日首次空闲时自动备份活动项目</span>
            </label>
            <div className="atm-form-grid">
              <div className="atm-field">
                <label htmlFor="daily-keep">每日备份保留数</label>
                <input
                  id="daily-keep"
                  type="number"
                  min="1"
                  max="90"
                  value={dailyKeep}
                  onChange={(event) => setDailyKeep(Number(event.target.value))}
                />
              </div>
              <div className="atm-field">
                <label htmlFor="weekly-keep">每周备份保留数</label>
                <input
                  id="weekly-keep"
                  type="number"
                  min="1"
                  max="52"
                  value={weeklyKeep}
                  onChange={(event) => setWeeklyKeep(Number(event.target.value))}
                />
              </div>
            </div>
            <NotificationPolicy value={notificationMode} onChange={setNotificationMode} />
            {desktop?.setAutoLaunch ? (
              <div className="atm-row">
                <div>
                  <div className="atm-row-title">登录时启动</div>
                  <div className="atm-row-sub">登录后随机延迟 8–45 秒启动，并常驻托盘</div>
                </div>
                <button
                  className="atm-button"
                  disabled={autoLaunch === null}
                  onClick={async () => setAutoLaunch(await desktop.setAutoLaunch!(!autoLaunch))}
                >
                  {autoLaunch ? "已开启" : "已关闭"}
                </button>
              </div>
            ) : null}
            {desktop?.getUpdateStatus ? (
              <div className="atm-row" data-testid="update-diagnostics">
                <div>
                  <div className="atm-row-title">自动更新</div>
                  <div className="atm-row-sub">
                    {updateStatus.isLoading
                      ? "正在读取最近结果…"
                      : updateStatus.data
                        ? `${updateStatus.data.message} · ${formatTime(updateStatus.data.at)}${
                            updateStatus.data.outcome === "ERROR"
                              ? `；${updateStatus.data.action}`
                              : ""
                          }`
                        : "尚无更新检查记录"}
                  </div>
                </div>
                <div className="atm-actions">
                  {updateStatus.data ? (
                    <span
                      className={`atm-badge ${
                        updateStatus.data.outcome === "ERROR"
                          ? "danger"
                          : updateStatus.data.outcome === "SUCCESS"
                            ? "success"
                            : updateStatus.data.outcome === "IN_PROGRESS"
                              ? "primary"
                              : ""
                      }`}
                    >
                      {updateStatus.data.outcome === "ERROR"
                        ? "失败"
                        : updateStatus.data.outcome === "SUCCESS"
                          ? "已完成"
                          : updateStatus.data.outcome === "IN_PROGRESS"
                            ? "检查中"
                            : "无更新"}
                    </span>
                  ) : null}
                  {desktop.checkForUpdates ? (
                    <button
                      className="atm-button"
                      disabled={checkUpdate.isPending}
                      onClick={() => checkUpdate.mutate()}
                    >
                      立即检查
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <button
              className="atm-button primary"
              disabled={savePolicy.isPending || settings.isLoading}
              onClick={() => savePolicy.mutate()}
            >
              保存设置
            </button>
            {savePolicy.error ? (
              <div className="atm-inline-error">
                {savePolicy.error instanceof Error
                  ? savePolicy.error.message
                  : String(savePolicy.error)}
              </div>
            ) : null}
          </div>
        </section>
      </div>
      {feedback ? (
        <div className="atm-notice" role="status">
          {feedback}
        </div>
      ) : null}
    </>
  );
}
