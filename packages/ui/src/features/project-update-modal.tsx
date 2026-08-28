import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import type { AyanamiClient } from "@ayanami-task/client";
import { AtmSelect } from "../components/atm-select.js";
import { Empty } from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import { useDialogAccessibility } from "../hooks/use-dialog-accessibility.js";
import { formatTime, statusLabels } from "../presentation.js";

export function ProjectUpdateModal({
  client,
  project,
  close,
  notify,
}: {
  client: AyanamiClient;
  project: string;
  close: () => void;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useDialogAccessibility(close);
  const history = useQuery({
    queryKey: ["project-updates", project],
    queryFn: () => client.projects.updates(project),
  });
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [health, setHealth] = useState("UNKNOWN");
  const [summary, setSummary] = useState("");
  const generate = useMutation({
    mutationFn: () => client.projects.draftUpdate(project, `ui-draft-${crypto.randomUUID()}`),
    onSuccess: (value) => {
      setDraft(value);
      setHealth(String(value.health));
      setSummary(String(value.summary));
    },
  });
  const publish = useMutation({
    mutationFn: () =>
      client.projects.publishUpdate(project, {
        opId: `ui-publish-${crypto.randomUUID()}`,
        draftId: draft?.id,
        health,
        summary,
        completed: draft?.completed ?? [],
        risks: draft?.risks ?? [],
        next: draft?.next ?? [],
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project-updates", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["brief", project] }),
      ]);
      notify("项目更新已发布");
      close();
    },
  });
  const error = generate.error ?? publish.error;
  return (
    <div className="atm-modal-backdrop">
      <section
        ref={dialogRef}
        className="atm-modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-update-title"
        tabIndex={-1}
      >
        <header className="atm-modal-head">
          <h2 id="project-update-title">发布项目更新</h2>
          <button className="atm-button atm-icon-button" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="atm-modal-body atm-form">
          {!draft ? (
            <section className="atm-panel">
              <Empty
                title="生成确定性草稿"
                text="系统根据上次发布后的完成项、当前风险和下一批活动任务生成草稿。"
                action={
                  <button
                    className="atm-button primary"
                    disabled={generate.isPending}
                    onClick={() => generate.mutate()}
                  >
                    {generate.isPending ? "正在生成" : "生成更新草稿"}
                  </button>
                }
              />
            </section>
          ) : (
            <>
              <div className="atm-field">
                <label htmlFor="project-health">项目健康度</label>
                <AtmSelect
                  id="project-health"
                  ariaLabel="项目健康度"
                  value={health}
                  options={[
                    { value: "UNKNOWN", label: "未知" },
                    { value: "ON_TRACK", label: "正常" },
                    { value: "AT_RISK", label: "有风险" },
                    { value: "OFF_TRACK", label: "偏离计划" },
                  ]}
                  onChange={setHealth}
                />
              </div>
              <div className="atm-field">
                <label htmlFor="project-update-summary">当前判断</label>
                <textarea
                  id="project-update-summary"
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                />
              </div>
              <div className="atm-form-grid">
                <div className="atm-panel-body">
                  <strong>已完成</strong>
                  {(draft.completed as string[]).length ? (
                    (draft.completed as string[]).map((item) => (
                      <div className="atm-row-sub" key={item}>
                        · {item}
                      </div>
                    ))
                  ) : (
                    <div className="atm-row-sub">暂无新增完成项</div>
                  )}
                </div>
                <div className="atm-panel-body">
                  <strong>风险</strong>
                  {(draft.risks as string[]).length ? (
                    (draft.risks as string[]).map((item) => (
                      <div className="atm-row-sub" key={item}>
                        · {item}
                      </div>
                    ))
                  ) : (
                    <div className="atm-row-sub">当前无阻塞风险</div>
                  )}
                </div>
              </div>
              <div className="atm-panel-body">
                <strong>下一步</strong>
                {(draft.next as string[]).map((item) => (
                  <div className="atm-row-sub" key={item}>
                    · {item}
                  </div>
                ))}
              </div>
            </>
          )}
          {history.data?.some((item) => item.status === "PUBLISHED") ? (
            <section className="atm-section">
              <h3>最近发布</h3>
              {history.data
                .filter((item) => item.status === "PUBLISHED")
                .slice(0, 3)
                .map((item) => (
                  <div className="atm-row" key={item.id}>
                    <div>
                      <div className="atm-row-title">{item.summary}</div>
                      <div className="atm-row-sub">
                        {formatTime(item.publishedAt)} · {statusLabels[item.health] ?? item.health}
                      </div>
                    </div>
                  </div>
                ))}
            </section>
          ) : null}
          {error ? (
            <div className="atm-inline-error">
              {error instanceof Error ? error.message : String(error)}
            </div>
          ) : null}
        </div>
        <footer className="atm-modal-foot">
          <button className="atm-button" onClick={close}>
            取消
          </button>
          {draft ? (
            <button
              className="atm-button primary"
              disabled={!summary.trim() || publish.isPending}
              onClick={() => publish.mutate()}
            >
              发布更新
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
