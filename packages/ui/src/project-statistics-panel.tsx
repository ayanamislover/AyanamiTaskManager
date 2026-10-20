import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/icons/CaretDown";
import type { AyanamiClient } from "@ayanami-task/client";
import { MutationErrorAlert, SectionLoadError } from "./components/async-state.js";

/**
 * 读不出项目指标时说什么（W8g，W2 peer r3 P2-02）。读（`metrics.read`）从不当场扫：
 * - `NO_SOURCE_PATH`：项目没有源码目录，刷新也没用；
 * - `NO_DATA`，或只有任务指标、还没有项目指标（`available` 为真而 `project` 为空）：还没统计过，去点「刷新统计」；
 * - 刷新时 git 失败（`METRICS_FAILED`）等：服务端给的说明。
 */
export function engineeringUnavailable(data: {
  available?: boolean;
  reason?: string | null;
  message?: string | null;
  project?: unknown;
}): { title: string; detail: string } {
  if (data.reason === "NO_SOURCE_PATH")
    return { title: "此项目暂不可统计", detail: "项目没有源码目录" };
  if (data.reason === "NO_DATA" || (data.available && !data.project))
    return { title: "还没有统计", detail: "点「刷新统计」，按本地 Git 与文件算一次" };
  return {
    title: "此项目暂不可统计",
    detail: data.message ?? "源码目录不是可读取的 Git 仓库",
  };
}

export function EngineeringMetricsPanel({
  client,
  projectCode,
  formatCapturedAt,
}: {
  client: AyanamiClient;
  projectCode: string;
  formatCapturedAt: (value?: string | null) => string;
}) {
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(true);
  const engineering = useQuery({
    queryKey: ["engineering-metrics", projectCode],
    queryFn: () => client.projects.engineeringMetrics(projectCode),
    enabled: !collapsed,
  });
  const refresh = useMutation({
    mutationFn: () => client.projects.engineeringMetrics(projectCode, undefined, true),
    onSuccess: (value) => queryClient.setQueryData(["engineering-metrics", projectCode], value),
  });

  return (
    <section
      className={`atm-panel atm-engineering${collapsed ? " is-collapsed" : ""}`}
      aria-label="工程统计"
    >
      <div className="atm-panel-head">
        <button
          type="button"
          className="atm-engineering-toggle"
          aria-label={collapsed ? "展开工程统计" : "折叠工程统计"}
          aria-expanded={!collapsed}
          aria-controls="engineering-metrics-content"
          onClick={() => setCollapsed((value) => !value)}
        >
          <CaretDown size={17} aria-hidden="true" />
          <span>
            <strong>工程统计</strong>
            <small>由本地 Git 与文件事实计算，不生成质量评分</small>
          </span>
        </button>
        {!collapsed ? (
          <button
            className="atm-button"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {refresh.isPending ? "正在统计" : "刷新统计"}
          </button>
        ) : null}
      </div>
      <div id="engineering-metrics-content" hidden={collapsed}>
        <MutationErrorAlert error={refresh.error} />
        {engineering.isLoading ? (
          <div className="atm-panel-body" style={{ display: "grid", gap: 9 }}>
            {Array.from({ length: 2 }, (_, index) => (
              <div className="atm-skeleton" key={index} />
            ))}
          </div>
        ) : engineering.isError ? (
          <div className="atm-panel-body">
            <SectionLoadError
              message="工程统计没能读出来。"
              onRetry={() => void engineering.refetch()}
            />
          </div>
        ) : engineering.data?.available && engineering.data.project ? (
          <div className="atm-engineering-body">
            <div className="atm-engineering-kpis">
              <div>
                <span>Source LOC</span>
                <strong>{Number(engineering.data.project.sourceLoc).toLocaleString()}</strong>
              </div>
              <div>
                <span>Test LOC</span>
                <strong>{Number(engineering.data.project.testLoc).toLocaleString()}</strong>
              </div>
              <div>
                <span>文件</span>
                <strong>{Number(engineering.data.project.fileCount).toLocaleString()}</strong>
              </div>
              <div>
                <span>依赖</span>
                <strong>{Number(engineering.data.project.dependencyCount).toLocaleString()}</strong>
              </div>
              <div>
                <span>7 日净 LOC</span>
                <strong>{Number(engineering.data.project.netLoc7d).toLocaleString()}</strong>
              </div>
              <div>
                <span>30 日净 LOC</span>
                <strong>{Number(engineering.data.project.netLoc30d).toLocaleString()}</strong>
              </div>
            </div>
            {Math.abs(Number(engineering.data.project.netLoc7d)) > 5_000 ? (
              <div className="atm-inline-warning">
                最近 7 日实现规模偏大，请确认工作项是否需要继续拆分。
              </div>
            ) : null}
            <div className="atm-form-grid">
              <div>
                <h3>最大文件</h3>
                {(engineering.data.project.largestFiles as any[]).map((item) => (
                  <div className="atm-metric-file" key={item.path}>
                    <span>{item.path}</span>
                    <strong>{item.loc} LOC</strong>
                  </div>
                ))}
              </div>
              <div>
                <h3>高 churn（30 日）</h3>
                {(engineering.data.project.highChurnFiles as any[]).map((item) => (
                  <div className="atm-metric-file" key={item.path}>
                    <span>{item.path}</span>
                    <strong>{item.churn}</strong>
                  </div>
                ))}
              </div>
            </div>
            <div className="atm-row-sub">
              HEAD {String(engineering.data.project.head).slice(0, 10)} ·{" "}
              {formatCapturedAt(engineering.data.project.capturedAt)}
            </div>
          </div>
        ) : engineering.data ? (
          <div className="atm-panel-body">
            <div className="atm-row-title">{engineeringUnavailable(engineering.data).title}</div>
            <div className="atm-row-sub">{engineeringUnavailable(engineering.data).detail}</div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
