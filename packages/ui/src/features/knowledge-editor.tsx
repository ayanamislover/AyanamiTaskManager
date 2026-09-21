import { useEffect, useState } from "react";
import { MutationErrorAlert } from "../components/async-state.js";
import {
  displayList,
  KNOWLEDGE_SOURCE_LIMIT,
  listValue,
  sourceLabel,
  type KnowledgeForm,
} from "./knowledge-support.js";

export type KnowledgeSaveOverrides = Partial<Pick<KnowledgeForm, "tags" | "aliases" | "appliesTo">>;

export function KnowledgeEditor({
  form,
  pending,
  onChange,
  onDirty,
  onSave,
  onRemoveSource,
  pendingFileSource,
  onAddFileSource,
  onCancel,
  error,
  notice,
  discardPrompt,
  onKeepDraft,
  onDiscardDraft,
}: {
  form: KnowledgeForm;
  pending: boolean;
  onChange: <K extends keyof KnowledgeForm>(key: K, value: KnowledgeForm[K]) => void;
  onDirty: () => void;
  onSave: (overrides: KnowledgeSaveOverrides) => void;
  onRemoveSource: (index: number) => void;
  pendingFileSource?: string | null;
  onAddFileSource?: () => void;
  onCancel: () => void;
  error: unknown;
  notice: string;
  discardPrompt: boolean;
  onKeepDraft: () => void;
  onDiscardDraft: () => void;
}) {
  const [listDrafts, setListDrafts] = useState({
    tags: displayList(form.tags),
    aliases: displayList(form.aliases),
    appliesTo: displayList(form.appliesTo),
  });
  useEffect(() => {
    setListDrafts((current) => {
      const next = { ...current };
      if (listValue(current.tags).join("\u0000") !== form.tags.join("\u0000")) {
        next.tags = displayList(form.tags);
      }
      if (listValue(current.aliases).join("\u0000") !== form.aliases.join("\u0000")) {
        next.aliases = displayList(form.aliases);
      }
      if (listValue(current.appliesTo).join("\u0000") !== form.appliesTo.join("\u0000")) {
        next.appliesTo = displayList(form.appliesTo);
      }
      return next.tags === current.tags &&
        next.aliases === current.aliases &&
        next.appliesTo === current.appliesTo
        ? current
        : next;
    });
  }, [form.aliases, form.appliesTo, form.tags]);
  const updateListDraft = (key: keyof typeof listDrafts, value: string) => {
    onDirty();
    setListDrafts((current) => ({ ...current, [key]: value }));
  };
  const commitListDraft = (key: keyof typeof listDrafts) => {
    onChange(key, listValue(listDrafts[key]));
  };
  const saveOverrides: KnowledgeSaveOverrides = {
    tags: listValue(listDrafts.tags),
    aliases: listValue(listDrafts.aliases),
    appliesTo: listValue(listDrafts.appliesTo),
  };

  return (
    <>
      <div className="atm-panel-head">
        <div>
          <h2>{form.id ? "编辑知识" : "新建知识草稿"}</h2>
          <div className="atm-row-sub">
            {form.id
              ? `当前版本 v${form.version}；保存会产生不可变新修订。`
              : "导入和 Record 提炼只创建草稿，不会自动发布。"}
          </div>
        </div>
      </div>
      <fieldset disabled={pending} className="atm-panel-body atm-form atm-knowledge-editor-form">
        {notice ? (
          <div className="atm-inline-warning" role="status">
            {notice}
          </div>
        ) : null}
        {discardPrompt ? (
          <div className="atm-inline-warning atm-knowledge-discard-prompt" role="alert">
            <strong>当前草稿尚未保存</strong>
            <span>切换操作不会自动丢弃内容，请选择下一步。</span>
            <div className="atm-actions">
              <button className="atm-button" type="button" onClick={onKeepDraft}>
                继续编辑
              </button>
              <button className="atm-button danger" type="button" onClick={onDiscardDraft}>
                放弃草稿并继续
              </button>
            </div>
          </div>
        ) : null}
        <div className="atm-form-grid">
          <div className="atm-field">
            <label htmlFor="knowledge-title">标题</label>
            <input
              id="knowledge-title"
              value={form.title}
              onChange={(event) => onChange("title", event.target.value)}
              autoFocus
            />
          </div>
          <div className="atm-field">
            <label htmlFor="knowledge-slug">Slug</label>
            <input
              id="knowledge-slug"
              value={form.slug}
              onChange={(event) => onChange("slug", event.target.value)}
            />
          </div>
        </div>
        <div className="atm-field">
          <label htmlFor="knowledge-summary">摘要</label>
          <textarea
            id="knowledge-summary"
            rows={3}
            value={form.summary}
            onChange={(event) => onChange("summary", event.target.value)}
          />
        </div>
        <div className="atm-field">
          <label htmlFor="knowledge-use-when">使用场景</label>
          <textarea
            id="knowledge-use-when"
            rows={2}
            value={form.useWhen}
            onChange={(event) => onChange("useWhen", event.target.value)}
          />
        </div>
        <div className="atm-form-grid">
          <div className="atm-field">
            <label htmlFor="knowledge-tags">标签</label>
            <input
              id="knowledge-tags"
              value={listDrafts.tags}
              placeholder="用逗号、顿号或换行分隔"
              onChange={(event) => updateListDraft("tags", event.target.value)}
              onBlur={() => commitListDraft("tags")}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="knowledge-applies-to">适用范围</label>
            <input
              id="knowledge-applies-to"
              value={listDrafts.appliesTo}
              placeholder="例如 Windows、SQLite"
              onChange={(event) => updateListDraft("appliesTo", event.target.value)}
              onBlur={() => commitListDraft("appliesTo")}
            />
          </div>
        </div>
        <div className="atm-field">
          <label htmlFor="knowledge-aliases">别名</label>
          <input
            id="knowledge-aliases"
            value={listDrafts.aliases}
            placeholder="可选，用逗号、顿号或换行分隔"
            onChange={(event) => updateListDraft("aliases", event.target.value)}
            onBlur={() => commitListDraft("aliases")}
          />
        </div>
        <div className="atm-field">
          <label htmlFor="knowledge-body">Markdown 正文</label>
          <textarea
            id="knowledge-body"
            className="atm-knowledge-body-editor"
            rows={18}
            value={form.bodyMarkdown}
            onChange={(event) => onChange("bodyMarkdown", event.target.value)}
            spellCheck={false}
          />
          <small>正文按 Markdown 原文保存，不渲染不可信 HTML。</small>
        </div>
        <div className="atm-knowledge-sources">
          <div className="atm-row-title">
            来源引用（{form.sourceRefs.length}/{KNOWLEDGE_SOURCE_LIMIT}）
          </div>
          {form.sourceRefs.length ? (
            form.sourceRefs.map((source, index) => (
              <div
                className="atm-knowledge-source-row"
                key={`${source.type}:${source.reference}:${index}`}
              >
                <span className="atm-row-sub">{sourceLabel(source)}</span>
                <button
                  className="atm-button"
                  type="button"
                  aria-label={`删除来源 ${sourceLabel(source)}`}
                  onClick={() => onRemoveSource(index)}
                >
                  删除
                </button>
              </div>
            ))
          ) : (
            <div className="atm-row-sub">暂无来源引用。</div>
          )}
          {form.sourceRefs.length > KNOWLEDGE_SOURCE_LIMIT ? (
            <div className="atm-inline-warning" role="alert">
              来源引用超过 {KNOWLEDGE_SOURCE_LIMIT} 条上限，请删除多余来源后再保存。
            </div>
          ) : null}
          {pendingFileSource ? (
            <div className="atm-inline-warning" role="alert">
              <span>
                {form.sourceRefs.length > KNOWLEDGE_SOURCE_LIMIT
                  ? `当前有 ${form.sourceRefs.length} 条来源，超过 ${KNOWLEDGE_SOURCE_LIMIT} 条上限；请先删除超额来源，再决定是否加入本次导入文件“${pendingFileSource}”。`
                  : `原有来源已完整保留，可直接保存；本次导入文件“${pendingFileSource}”仅作提示，尚未加入来源。`}
              </span>
              <button
                className="atm-button"
                type="button"
                disabled={form.sourceRefs.length >= KNOWLEDGE_SOURCE_LIMIT}
                onClick={() => onAddFileSource?.()}
              >
                添加导入文件来源
              </button>
            </div>
          ) : null}
        </div>
        <MutationErrorAlert error={error} />
      </fieldset>
      <footer className="atm-knowledge-actions">
        <button className="atm-button" type="button" onClick={onCancel} disabled={pending}>
          取消编辑
        </button>
        <button
          className="atm-button primary"
          type="button"
          disabled={
            pending ||
            form.sourceRefs.length > KNOWLEDGE_SOURCE_LIMIT ||
            !form.slug.trim() ||
            !form.title.trim() ||
            !form.summary.trim()
          }
          onClick={() => onSave(saveOverrides)}
        >
          {pending ? "保存中…" : "确认保存修订"}
        </button>
      </footer>
    </>
  );
}
