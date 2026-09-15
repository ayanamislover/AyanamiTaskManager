import { MutationErrorAlert } from "../components/async-state.js";
import { displayList, listValue, sourceLabel, type KnowledgeForm } from "./knowledge-support.js";

export function KnowledgeEditor({
  form,
  pending,
  onChange,
  onSave,
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
  onSave: () => void;
  onCancel: () => void;
  error: unknown;
  notice: string;
  discardPrompt: boolean;
  onKeepDraft: () => void;
  onDiscardDraft: () => void;
}) {
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
      <div className="atm-panel-body atm-form atm-knowledge-editor-form">
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
              value={displayList(form.tags)}
              placeholder="用逗号分隔"
              onChange={(event) => onChange("tags", listValue(event.target.value))}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="knowledge-applies-to">适用范围</label>
            <input
              id="knowledge-applies-to"
              value={displayList(form.appliesTo)}
              placeholder="例如 Windows、SQLite"
              onChange={(event) => onChange("appliesTo", listValue(event.target.value))}
            />
          </div>
        </div>
        <div className="atm-field">
          <label htmlFor="knowledge-aliases">别名</label>
          <input
            id="knowledge-aliases"
            value={displayList(form.aliases)}
            placeholder="可选，用逗号分隔"
            onChange={(event) => onChange("aliases", listValue(event.target.value))}
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
        {form.sourceRefs.length ? (
          <div className="atm-knowledge-sources">
            <div className="atm-row-title">来源引用</div>
            {form.sourceRefs.map((source) => (
              <div className="atm-row-sub" key={`${source.type}:${source.reference}`}>
                {sourceLabel(source)}
              </div>
            ))}
          </div>
        ) : null}
        <MutationErrorAlert error={error} />
      </div>
      <footer className="atm-knowledge-actions">
        <button className="atm-button" type="button" onClick={onCancel} disabled={pending}>
          取消编辑
        </button>
        <button
          className="atm-button primary"
          type="button"
          disabled={pending || !form.slug.trim() || !form.title.trim() || !form.summary.trim()}
          onClick={onSave}
        >
          {pending ? "保存中…" : "确认保存修订"}
        </button>
      </footer>
    </>
  );
}
