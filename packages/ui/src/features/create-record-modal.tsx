import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import type { AyanamiClient, UserRecordCreateInput } from "@ayanami-task/client";
import { AtmSelect } from "../components/atm-select.js";
import type { Notify } from "../contracts.js";
import { useDialogAccessibility } from "../hooks/use-dialog-accessibility.js";
import { recordDraftToUserInput } from "../record-input.js";

export function CreateRecordModal({
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
  const [kind, setKind] = useState<UserRecordCreateInput["kind"]>("DECISION");
  const [importance, setImportance] =
    useState<NonNullable<UserRecordCreateInput["importance"]>>("NORMAL");
  const [topic, setTopic] = useState("");
  const [subjectKey, setSubjectKey] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      client.recordAsUser(
        project,
        recordDraftToUserInput({
          opId: `ui-record-${crypto.randomUUID()}`,
          kind,
          importance,
          title,
          summary,
          detail,
          topic,
          subjectKey,
        }),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["records", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      notify("项目记录已保存");
      close();
    },
  });
  return (
    <div className="atm-modal-backdrop">
      <section
        ref={dialogRef}
        className="atm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-modal-title"
        tabIndex={-1}
      >
        <header className="atm-modal-head">
          <h2 id="record-modal-title">新建项目记录</h2>
          <button className="atm-button atm-icon-button" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="atm-modal-body atm-form">
          <div className="atm-form-grid">
            <div className="atm-field">
              <label htmlFor="record-kind">类型</label>
              <AtmSelect
                id="record-kind"
                ariaLabel="记录类型"
                value={kind}
                options={[
                  { value: "DECISION", label: "决策" },
                  { value: "CONSTRAINT", label: "约束" },
                  { value: "FACT", label: "事实" },
                  { value: "RISK", label: "风险" },
                  { value: "REFERENCE", label: "参考" },
                  { value: "LESSON", label: "经验" },
                  { value: "VERIFICATION", label: "验证" },
                  { value: "WAIVER", label: "豁免" },
                ]}
                onChange={(value) => setKind(value as UserRecordCreateInput["kind"])}
              />
            </div>
            <div className="atm-field">
              <label htmlFor="record-importance">重要性</label>
              <AtmSelect
                id="record-importance"
                ariaLabel="记录重要性"
                value={importance}
                options={[
                  { value: "LOW", label: "低" },
                  { value: "NORMAL", label: "普通" },
                  { value: "HIGH", label: "高" },
                  { value: "CRITICAL", label: "紧急" },
                ]}
                onChange={(value) =>
                  setImportance(value as NonNullable<UserRecordCreateInput["importance"]>)
                }
              />
            </div>
          </div>
          <div className="atm-field">
            <label htmlFor="record-topic">主题（可选，用于发现相关记录）</label>
            <input
              id="record-topic"
              value={topic}
              maxLength={200}
              placeholder="例如：release/1.0.16 或 review/candidate-a"
              onChange={(event) => setTopic(event.target.value)}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="record-subject-key">主题标识（可选）</label>
            <input
              id="record-subject-key"
              value={subjectKey}
              maxLength={200}
              placeholder="例如：candidate:release-v1"
              onChange={(event) => setSubjectKey(event.target.value)}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="record-title">标题</label>
            <input
              id="record-title"
              data-dialog-autofocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="record-summary">摘要</label>
            <textarea
              id="record-summary"
              maxLength={300}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="record-detail">详细内容</label>
            <textarea
              id="record-detail"
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
            />
          </div>
          {mutation.error ? (
            <div className="atm-inline-error">
              {mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
            </div>
          ) : null}
        </div>
        <footer className="atm-modal-foot">
          <button className="atm-button" onClick={close}>
            取消
          </button>
          <button
            className="atm-button primary"
            disabled={!title.trim() || !summary.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            保存记录
          </button>
        </footer>
      </section>
    </div>
  );
}
