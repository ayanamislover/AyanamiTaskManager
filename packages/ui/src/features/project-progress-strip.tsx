import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";

export type ProgressStripCounts = {
  since: string;
  done: number;
  active: number;
  waiting: number;
  ready: number;
};

export type ProgressStripSegment = {
  key: "done" | "active" | "waiting" | "ready";
  label: string;
  count: number;
  /** 占整条的百分比；没有任务时四段都是 0。 */
  percent: number;
};

const SEGMENTS = [
  ["done", "已完成"],
  ["active", "进行中"],
  ["waiting", "等你"],
  ["ready", "可开始"],
] as const;

export const PROGRESS_STRIP_HINT =
  "已完成只算本次 ATM 启动以来完成的任务，重启后清零。进行中含待整理、已领取、执行中、验收中和等待 Agent；等你含等你回复和受阻（受阻多半要你出手解除）。";

export function progressStripSegments(counts: ProgressStripCounts): ProgressStripSegment[] {
  const total = counts.done + counts.active + counts.waiting + counts.ready;
  return SEGMENTS.map(([key, label]) => ({
    key,
    label,
    count: counts[key],
    percent: total === 0 ? 0 : (counts[key] / total) * 100,
  }));
}

const NO_COUNTS: ProgressStripCounts = { since: "", done: 0, active: 0, waiting: 0, ready: 0 };

/** counts 为 null 表示还在读：结构和尺寸与读完一样，数字位显示破折号。 */
export function ProgressStripView({ counts }: { counts: ProgressStripCounts | null }) {
  const loading = counts === null;
  const segments = progressStripSegments(counts ?? NO_COUNTS);
  const done = segments[0]!;
  const hintId = useId();
  return (
    // 口径说明只放在 title 里，键盘和读屏都够不着；再挂一份给 aria-describedby。
    <section
      className="atm-panel atm-progress-strip"
      aria-label="项目进度"
      aria-describedby={hintId}
      aria-busy={loading || undefined}
    >
      <span className="atm-visually-hidden" id={hintId}>
        {PROGRESS_STRIP_HINT}
      </span>
      <div className="atm-progress-strip-row">
        <div className="atm-progress-strip-big">
          {loading ? "—" : `${Math.round(done.percent)}%`}
          <small>本次完成</small>
        </div>
        <div
          className="atm-progress-strip-bar"
          role="img"
          aria-label={loading ? "正在读取" : stripSummary(segments)}
        >
          {segments
            .filter((segment) => segment.count > 0)
            .map((segment) => (
              <i
                key={segment.key}
                data-segment={segment.key}
                style={{ width: `${segment.percent}%` }}
              />
            ))}
        </div>
      </div>
      <div className="atm-progress-strip-legend" title={PROGRESS_STRIP_HINT}>
        {segments.map((segment) => (
          <span key={segment.key} data-segment={segment.key}>
            {segment.label}
            <b>{loading ? "—" : segment.count}</b>
          </span>
        ))}
      </div>
    </section>
  );
}

function stripSummary(segments: ProgressStripSegment[]): string {
  return segments.map((segment) => `${segment.label} ${segment.count}`).join("，");
}

export function ProjectProgressStrip({
  client,
  projectCode,
}: {
  client: AyanamiClient;
  projectCode: string;
}) {
  // 键挂在 ["tasks", project] 下面：任务一有变动，现有的失效逻辑就会顺带刷新它。
  const strip = useQuery({
    queryKey: ["tasks", projectCode, "progress-strip"],
    queryFn: () => client.tasks.progressStripForUi(projectCode),
  });
  // 读取中也占着同样的位置：以前这里返回 null，数据回来时整条插进来，把下面的列表往下推一截。
  // 读失败时不留空壳。
  if (strip.isPending) return <ProgressStripView counts={null} />;
  if (!strip.data) return null;
  return <ProgressStripView counts={strip.data} />;
}
