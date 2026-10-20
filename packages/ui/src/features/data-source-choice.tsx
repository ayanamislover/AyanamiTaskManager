import { useState } from "react";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/icons/CheckCircle";
import { useDialogs } from "../components/atm-dialogs.js";
import { LoadingRows, MutationErrorAlert, PageHead } from "../components/async-state.js";
import { moveRovingFocus } from "../components/keyboard-interactions.js";
import type { DataSourceChoice, DataSourceConflictCause, DataSourceState } from "../contracts.js";

/**
 * 数据源冲突（07 §7）：3.0 判断不了该用哪一边的数据，等用户在这里二选一。
 * 选择只经桌面桥交给宿主（只认 User）；做决定之前服务不读写任何项目数据，Agent 也连不上。
 */
const CAUSES: Record<DataSourceConflictCause, string> = {
  CHANGED: "转换到 3.0 之后，2.x 的数据又有了修改。",
  UNREADABLE: "2.x 的数据现在读不出来，无法确认转换到 3.0 之后它有没有被修改。",
  LEGACY_GONE: "上次退回到了 2.x，但 2.x 的数据目录现在不在了。",
  OTHER_SOURCE: "3.0 的数据是从另一个 2.x 数据目录转换来的，和现在的不是同一个。",
  RECORD: "3.0 记录的数据来源对不上，没法自己判断该用哪一边。",
};

const OPTIONS: ReadonlyArray<{
  choice: DataSourceChoice;
  label: string;
  description: string;
  confirm: string;
}> = [
  {
    choice: "KEEP_V3",
    label: "沿用 3.0",
    description: "继续用 3.0 里的数据；2.x 期间的修改不会带过来，2.x 的数据原样留着。",
    confirm: "沿用 3.0 里的数据。2.x 期间的修改不会带过来，2.x 的数据原样留着。",
  },
  {
    choice: "RECONVERT",
    label: "从 2.x 重新转换",
    description: "以 2.x 的数据为准重新转换；当前 3.0 的数据封存起来，不会删除。",
    confirm: "以 2.x 的数据为准重新转换。当前 3.0 的数据封存起来，不会删除。",
  },
];

/** 某一边在这种原因下做不成：给出说明，选项不可选。 */
function unavailable(cause: DataSourceConflictCause, choice: DataSourceChoice): string | null {
  if (choice === "KEEP_V3" && cause === "OTHER_SOURCE")
    return "数据目录换过，3.0 的数据绑不到现在这个目录，沿用不了。";
  if (choice === "RECONVERT" && cause === "LEGACY_GONE")
    return "2.x 的数据目录不在，没有可转换的数据。";
  return null;
}

export function DataSourceChoicePage({
  source,
  choose,
}: {
  source: DataSourceState;
  choose: (choice: DataSourceChoice) => Promise<void>;
}) {
  const dialogs = useDialogs();
  const cause = source.state === "SOURCE_CONFLICT" ? source.cause : "RECORD";
  const usable = OPTIONS.filter((option) => !unavailable(cause, option.choice));
  const [selected, setSelected] = useState<DataSourceChoice | null>(
    usable.length === 1 ? usable[0]!.choice : null,
  );
  const [failed, setFailed] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  if (source.state !== "SOURCE_CONFLICT") {
    return (
      <div className="atm-source-choice">
        <PageHead
          title="正在按你的选择启动"
          description="选好的数据来源正在载入，完成后自动回到原来的页面。"
        />
        <section className="atm-panel" aria-busy="true">
          <LoadingRows count={3} />
        </section>
      </div>
    );
  }

  const option = OPTIONS.find((candidate) => candidate.choice === selected) ?? null;
  const submit = async () => {
    if (!option) return;
    const confirmed = await dialogs.confirm({
      title: `${option.label}？`,
      message: option.confirm,
      confirmLabel: option.label,
      tone: "primary",
    });
    if (!confirmed) return;
    setFailed(null);
    setSubmitting(true);
    try {
      await choose(option.choice);
    } catch (error) {
      setFailed(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="atm-source-choice">
      <PageHead
        title="需要选择数据来源"
        description={`${CAUSES[cause]}选择之前，ATM 不读写任何项目数据，Agent 也暂时连不上；两边的数据都会保留。`}
      />
      <section className="atm-panel">
        <div className="atm-panel-head">
          <h2>用哪一边的数据</h2>
        </div>
        <div className="atm-panel-body atm-source-choice-body">
          <div className="atm-notification-options" role="radiogroup" aria-label="数据来源">
            {OPTIONS.map((candidate, index) => {
              const blocked = unavailable(cause, candidate.choice);
              const checked = selected === candidate.choice;
              return (
                <button
                  className="atm-notification-option"
                  data-selected={checked ? "true" : "false"}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={Boolean(blocked) || submitting}
                  tabIndex={checked || (selected === null && index === 0) ? 0 : -1}
                  onClick={() => setSelected(candidate.choice)}
                  onKeyDown={(event) =>
                    moveRovingFocus(event, {
                      selector: '[role="radio"]:not(:disabled)',
                      index: usable.findIndex((u) => u.choice === candidate.choice),
                      count: usable.length,
                      vertical: true,
                      onMove: (next) => setSelected(usable[next]!.choice),
                    })
                  }
                  key={candidate.choice}
                >
                  <span className="atm-notification-radio" aria-hidden="true">
                    {checked ? <CheckCircle size={17} weight="fill" /> : null}
                  </span>
                  <span>
                    <strong>{candidate.label}</strong>
                    <small>{blocked ?? candidate.description}</small>
                  </span>
                </button>
              );
            })}
          </div>
          <MutationErrorAlert
            errors={[failed, source.error ? new Error(source.error) : null]}
            prefix="上一次的选择没有做成："
          />
          <dl className="atm-source-choice-detail">
            <dt>原因（原文）</dt>
            <dd>{source.reason}</dd>
            {source.since ? (
              <>
                <dt>发现于</dt>
                <dd>{source.since}</dd>
              </>
            ) : null}
          </dl>
          <div className="atm-actions">
            <button
              className="atm-button primary"
              type="button"
              disabled={!option || submitting}
              onClick={() => void submit()}
            >
              {submitting ? "正在提交…" : option ? `${option.label}，继续` : "先选一边"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
