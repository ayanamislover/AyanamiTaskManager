import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/icons/CaretDown";
import type { AyanamiClient } from "@ayanami-task/client";
import { formatTime } from "../presentation.js";
import { EngineeringMetricsPanel } from "../project-statistics-panel.js";
import { reconciliationSummary } from "../reconciliation.js";
import { ProjectReconcile } from "./project-reconcile.js";

/**
 * 任务对账、工程统计是排障用的，日常不需要看。以前它们平铺在项目页中间，
 * 任务列表被挤到 1300px 以下。现在收成一个默认折叠的「诊断」区放在页尾；
 * 只有真出了错（对账检查本身失败）才自动展开并移到页首。
 * 3.0 是单库，没有数据投影，投影健康面板随之删除（00 §6）。
 *
 * 待对账的任务数只是提示，不算出错，只显示在折叠条上。
 */
export function projectDiagnosticsNeedAttention(input: { reconciliationError: unknown }): boolean {
  return Boolean(input.reconciliationError);
}

export function useProjectDiagnostics(client: AyanamiClient, projectCode: string) {
  const reconciliation = useQuery({
    queryKey: ["reconciliation", projectCode],
    queryFn: () => client.projects.reconciliation(projectCode),
  });
  const attention = projectDiagnosticsNeedAttention({
    reconciliationError: reconciliation.error,
  });
  // 出过错就在本次浏览里固定展开并留在页首：点「立即重试」恢复后面板不能突然收起、跳到页尾。
  const [pinned, setPinned] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setPinned(null);
    setOpen(false);
  }, [projectCode]);
  useEffect(() => {
    if (!attention) return;
    setPinned(projectCode);
    setOpen(true);
  }, [attention, projectCode]);
  return {
    attention,
    atTop: attention || pinned === projectCode,
    open,
    setOpen,
    reconciliationAttention: reconciliation.data?.attentionCount ?? 0,
  };
}

export function ProjectDiagnostics({
  client,
  projectCode,
  openTask,
  diagnostics,
}: {
  client: AyanamiClient;
  projectCode: string;
  openTask: (key: string) => void;
  diagnostics: ReturnType<typeof useProjectDiagnostics>;
}) {
  const { open, setOpen, reconciliationAttention, attention } = diagnostics;
  return (
    <section
      className={`atm-diagnostics${diagnostics.atTop ? " is-top" : ""}`}
      aria-label="项目诊断"
      data-attention={attention ? "true" : undefined}
    >
      <div className={`atm-panel atm-engineering${open ? "" : " is-collapsed"}`}>
        <div className="atm-panel-head">
          <button
            type="button"
            className="atm-engineering-toggle"
            aria-label={open ? "折叠项目诊断" : "展开项目诊断"}
            aria-expanded={open}
            aria-controls="project-diagnostics-content"
            onClick={() => setOpen(!open)}
          >
            <CaretDown size={17} aria-hidden="true" />
            <span>
              <strong>诊断</strong>
              <small>任务对账与工程统计</small>
            </span>
          </button>
          <span className="atm-actions">
            <span className={`atm-badge${reconciliationAttention ? " warning" : ""}`}>
              {reconciliationSummary({ attentionCount: reconciliationAttention })}
            </span>
          </span>
        </div>
      </div>
      <div
        id="project-diagnostics-content"
        className="atm-diagnostics-body atm-disclosure-body"
        hidden={!open}
      >
        {/* 折叠时不挂载子面板：工程统计、对账都不该在没人看的时候取数和渲染。 */}
        {open ? (
          <>
            <ProjectReconcile client={client} projectCode={projectCode} openTask={openTask} />
            <EngineeringMetricsPanel
              client={client}
              projectCode={projectCode}
              formatCapturedAt={formatTime}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}
