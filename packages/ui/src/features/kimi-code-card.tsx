import { useQuery } from "@tanstack/react-query";
import type { DesktopBridge, KimiCodeStatus } from "../contracts.js";

/**
 * Kimi Code 目前是用户手动配置的：ATM 只读它的 MCP 配置，报告登记了哪几个 ATM profile。
 * 「交给 ATM 管理」要等接管（安装、更新、修复、卸载）做完才能点，见 ATM-T-0526。
 */
export function KimiCodeCardView({ status }: { status: KimiCodeStatus }) {
  const connected = status.profiles.length > 0;
  return (
    <article className="atm-integration-card" data-testid="kimi-code-integration">
      <header>
        <strong>Kimi Code</strong>
        <span className={connected ? "atm-badge success" : "atm-badge"}>
          {connected ? "已接入（手动配置）" : "未接入"}
        </span>
      </header>
      <div className="atm-integration-checks">
        <span>MCP</span>
        <span className="atm-row-sub">
          {connected ? status.profiles.join(" · ") : "配置里没有 ATM"}
        </span>
        <span>配置文件</span>
        <span className="atm-row-sub atm-kimi-config-path">{status.configPath}</span>
      </div>
      <div className="atm-row-sub">由 ATM 接管安装、更新与修复的功能还在开发中。</div>
      <div className="atm-actions">
        <button className="atm-button" disabled title="接管功能开发中">
          交给 ATM 管理
        </button>
      </div>
    </article>
  );
}

export function KimiCodeCard({ desktop }: { desktop: DesktopBridge }) {
  const status = useQuery({
    queryKey: ["kimi-code-status"],
    queryFn: () => desktop.getKimiCodeStatus!(),
    enabled: Boolean(desktop.getKimiCodeStatus),
  });
  if (!status.data) return null;
  return <KimiCodeCardView status={status.data} />;
}
