import { useCallback, useEffect, useRef, useState } from "react";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/icons/CaretDown";
import type { McpBridgeObservation } from "./contracts.js";

export type { McpBridgeObservation } from "./contracts.js";

const REFRESH_INTERVAL_MS = 30_000;
const MIB = 1024 * 1024;

function mib(bytes: number): string {
  return `${(bytes / MIB).toFixed(2)} MiB`;
}

function defaultFormatDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function McpBridgeObservationView({
  observation,
  formatDate = defaultFormatDate,
}: {
  observation: McpBridgeObservation;
  formatDate?: (value: string) => string;
}) {
  const clientCount = new Set(
    observation.bridges.map((bridge) => `${bridge.ownerName}:${bridge.ownerPid ?? "unknown"}`),
  ).size;
  return (
    <div className="atm-mcp-bridge-body">
      <div className="atm-engineering-kpis atm-mcp-bridge-kpis">
        <div>
          <span>当前连接</span>
          <strong>{observation.bridges.length} 个连接</strong>
        </div>
        <div>
          <span>客户端进程</span>
          <strong>{clientCount} 个客户端进程</strong>
        </div>
        <div>
          <span>累计 Private Bytes</span>
          <strong>{mib(observation.totalPrivateBytes)}</strong>
        </div>
      </div>
      <p className="atm-mcp-bridge-note">
        内存按诊断脚本相同的 Private Bytes 口径累计，不把共享映像页重复计入总量。
      </p>
      {observation.bridges.length === 0 ? (
        <div className="atm-mcp-bridge-empty">当前没有 stdio bridge 连接。</div>
      ) : (
        <div className="atm-mcp-bridge-list" role="list" aria-label="当前 MCP bridge 连接">
          <div className="atm-mcp-bridge-row atm-mcp-bridge-header" aria-hidden="true">
            <span>客户端进程</span>
            <span>bridge PID</span>
            <span>建立时间</span>
            <span>Private Bytes</span>
          </div>
          {observation.bridges.map((bridge) => (
            <div className="atm-mcp-bridge-row" role="listitem" key={bridge.pid}>
              <div>
                <strong>{bridge.ownerName}</strong>
                <span>{bridge.ownerPid === null ? "父进程不可读" : `PID ${bridge.ownerPid}`}</span>
              </div>
              <span className="atm-key">bridge {bridge.pid}</span>
              <span>{formatDate(bridge.startedAt)}</span>
              <strong>{mib(bridge.privateBytes)}</strong>
            </div>
          ))}
        </div>
      )}
      <div className="atm-mcp-bridge-sampled">采样于 {formatDate(observation.sampledAt)}</div>
    </div>
  );
}

export function McpBridgePanel({
  load,
  formatDate,
}: {
  load: () => Promise<McpBridgeObservation>;
  formatDate?: (value: string) => string;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [observation, setObservation] = useState<McpBridgeObservation | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef<Promise<void> | null>(null);
  const inFlightMarker = useRef<symbol | null>(null);
  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    const marker = Symbol("mcp-bridge-refresh");
    const current = (async () => {
      setPending(true);
      setError("");
      try {
        setObservation(await load());
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setPending(false);
        if (inFlightMarker.current === marker) {
          inFlight.current = null;
          inFlightMarker.current = null;
        }
      }
    })();
    inFlightMarker.current = marker;
    inFlight.current = current;
    return current;
  }, [load]);

  useEffect(() => {
    if (collapsed) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [collapsed, refresh]);

  return (
    <section
      className={`atm-panel atm-engineering atm-mcp-bridges${collapsed ? " is-collapsed" : ""}`}
      aria-label="MCP bridge 观测"
    >
      <div className="atm-panel-head">
        <button
          type="button"
          className="atm-engineering-toggle"
          aria-label={collapsed ? "展开 MCP bridge 观测" : "折叠 MCP bridge 观测"}
          aria-expanded={!collapsed}
          aria-controls="mcp-bridge-observation-content"
          onClick={() => setCollapsed((value) => !value)}
        >
          <CaretDown size={17} aria-hidden="true" />
          <span>
            <strong>MCP bridge 连接</strong>
            <small>只读、按需观测当前 stdio 连接归属与真实私有内存</small>
          </span>
        </button>
        {!collapsed ? (
          <button className="atm-button" disabled={pending} onClick={() => void refresh()}>
            {pending ? "正在观测" : "刷新观测"}
          </button>
        ) : null}
      </div>
      <div id="mcp-bridge-observation-content" hidden={collapsed}>
        {error ? (
          <div className="atm-panel-body">
            <div className="atm-inline-error" role="alert">
              读取 bridge 连接失败：{error}
            </div>
          </div>
        ) : observation ? (
          <McpBridgeObservationView
            observation={observation}
            {...(formatDate === undefined ? {} : { formatDate })}
          />
        ) : (
          <div className="atm-panel-body" aria-live="polite">
            {pending ? "正在读取当前 bridge 连接…" : "展开后开始观测。"}
          </div>
        )}
      </div>
    </section>
  );
}
