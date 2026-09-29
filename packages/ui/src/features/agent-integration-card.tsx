import { Fragment } from "react";
import type { AgentIntegrationAction, AgentIntegrationReport } from "../contracts.js";
import {
  AgentIntegrationBadge,
  agentClientLabel,
  agentIntegrationErrorMessage,
  integrationState,
} from "../presentation.js";

/** 设置页「Agent 接入」里的一张客户端卡片：MCP、规则、Skill 各自的状态，和一组操作。 */
export function AgentIntegrationCard({
  report,
  pending,
  onAction,
}: {
  report: AgentIntegrationReport;
  pending: boolean;
  onAction(action: AgentIntegrationAction): void;
}) {
  const overall = integrationState(report);
  const primaryAction: AgentIntegrationAction =
    overall === "MODIFIED" ? "REPAIR" : overall === "NEEDS_UPDATE" ? "UPDATE" : "INSTALL";
  const primaryLabel =
    primaryAction === "REPAIR" ? "修复" : primaryAction === "UPDATE" ? "更新" : "安装";
  // Claude Code 缺 CLI、Kimi Code 没装（~/.kimi-code 不存在）都算「本体不在」。
  const cliUnavailable = !report.cliAvailable;
  const installNeedsCli = cliUnavailable && !report.mcpInstalled;
  return (
    <article className="atm-integration-card">
      <header>
        <strong>{agentClientLabel(report.client)}</strong>
        <AgentIntegrationBadge state={overall} />
      </header>
      <div className="atm-integration-checks">
        <span>MCP</span>
        <AgentIntegrationBadge state={report.mcpInstalled ? "INSTALLED" : "NOT_INSTALLED"} />
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
            <span>{report.client === "CLAUDE_CODE" ? "CLI" : "客户端"}</span>
            <span className="atm-row-sub">
              {report.client === "KIMI_CODE"
                ? "未检测到，请先安装 Kimi Code"
                : "未检测到，安装/卸载不可用"}
            </span>
          </>
        ) : null}
      </div>
      {report.repairError ? (
        <div className="atm-inline-error" role="alert">
          自动修复失败：{agentIntegrationErrorMessage(report.repairError)}
        </div>
      ) : null}
      <div className="atm-actions">
        <button className="atm-button" disabled={pending} onClick={() => onAction("PREVIEW")}>
          预览修改
        </button>
        {overall !== "INSTALLED" ? (
          <button
            className="atm-button primary"
            disabled={pending || installNeedsCli}
            onClick={() => onAction(primaryAction)}
          >
            {primaryLabel}
          </button>
        ) : null}
        {overall !== "NOT_INSTALLED" ? (
          <button
            className="atm-button danger"
            disabled={pending || cliUnavailable}
            onClick={() => onAction("UNINSTALL")}
          >
            卸载 ATM 接入
          </button>
        ) : null}
      </div>
    </article>
  );
}
