import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/icons/CaretDown";
import type { AyanamiClient } from "@ayanami-task/client";
import { ErrorState, LoadingRows } from "../components/async-state.js";
import {
  formatReconciliationAge,
  reconciliationLabel,
  reconciliationSummary,
} from "../reconciliation.js";

export function ProjectReconcile({
  client,
  projectCode,
  openTask,
}: {
  client: AyanamiClient;
  projectCode: string;
  openTask: (key: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const reconciliation = useQuery({
    queryKey: ["reconciliation", projectCode],
    queryFn: () => client.projects.reconciliation(projectCode),
  });

  return (
    <section
      className={`atm-panel atm-engineering${collapsed ? " is-collapsed" : ""}`}
      aria-label="任务对账"
    >
      <div className="atm-panel-head">
        <button
          type="button"
          className="atm-engineering-toggle"
          aria-label={collapsed ? "展开任务对账" : "折叠任务对账"}
          aria-expanded={!collapsed}
          aria-controls="task-reconciliation-content"
          onClick={() => setCollapsed((value) => !value)}
        >
          <CaretDown size={17} aria-hidden="true" />
          <span>
            <strong>
              {reconciliation.error ? "对账检查失败" : reconciliationSummary(reconciliation.data)}
            </strong>
          </span>
        </button>
      </div>
      <div id="task-reconciliation-content" hidden={collapsed}>
        {reconciliation.isLoading ? (
          <LoadingRows count={2} />
        ) : reconciliation.error ? (
          <ErrorState error={reconciliation.error} />
        ) : reconciliation.data?.items.length ? (
          <div className="atm-list">
            {reconciliation.data.items.map((item) => (
              <button
                className="atm-row"
                key={`${item.taskKey}:${item.classification}`}
                onClick={() => openTask(item.taskKey)}
              >
                <div>
                  <div className="atm-row-title">{item.title}</div>
                  <div className="atm-row-sub">
                    {item.taskKey} · {reconciliationLabel(item.classification)} · 已持续{" "}
                    {formatReconciliationAge(item.ageSeconds)}
                  </div>
                  {item.session ? (
                    <div className="atm-row-sub">
                      Session：{item.session.displayName} · {item.session.connectionState}
                    </div>
                  ) : null}
                  {item.evidencePaths.length ? (
                    <div className="atm-row-sub">已发现产物：{item.evidencePaths.join("、")}</div>
                  ) : null}
                  <div className="atm-row-sub">建议：{item.suggestedAction}</div>
                </div>
                <span
                  className={`atm-badge ${
                    item.classification === "STALLED"
                      ? "danger"
                      : item.classification === "LEASE_EXPIRED_ONLINE"
                        ? "warning"
                        : "primary"
                  }`}
                >
                  {reconciliationLabel(item.classification)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="atm-panel-body">
            <div className="atm-row-title">当前没有需对账项</div>
          </div>
        )}
      </div>
    </section>
  );
}
