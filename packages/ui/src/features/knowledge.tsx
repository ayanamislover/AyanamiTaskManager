import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadSimpleIcon as Download } from "@phosphor-icons/react/dist/icons/DownloadSimple";
import { FileArrowUpIcon as FileArrowUp } from "@phosphor-icons/react/dist/icons/FileArrowUp";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import type { AyanamiClient, KnowledgeSaveInput } from "@ayanami-task/client";
import {
  Empty,
  ErrorState,
  LoadingRows,
  MutationErrorAlert,
  PageHead,
} from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import { KnowledgeDetail } from "./knowledge-detail.js";
import { KnowledgeEditor } from "./knowledge-editor.js";
import {
  emptyForm,
  exportMarkdown,
  formFromEntry,
  importedMarkdown,
  readFullEntry,
  displayList,
  slugFromName,
  type KnowledgeDraftSeed,
  type KnowledgeForm,
  type PendingNavigation,
} from "./knowledge-support.js";

export type { KnowledgeDraftSeed } from "./knowledge-support.js";

export function KnowledgePage({
  client,
  notify,
  draft,
  onDraftConsumed,
}: {
  client: AyanamiClient;
  notify: Notify;
  draft?: KnowledgeDraftSeed | null;
  onDraftConsumed?: () => void;
}) {
  const queryClient = useQueryClient();
  const [queryText, setQueryText] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState<KnowledgeForm>(() => emptyForm());
  const [showHistory, setShowHistory] = useState(false);
  const [historyNotice, setHistoryNotice] = useState("");
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const [searchGeneration, setSearchGeneration] = useState(0);
  const saveOperation = useRef<{ fingerprint: string; opId: string } | null>(null);
  const archiveOperation = useRef<{ fingerprint: string; opId: string } | null>(null);
  const search = client.knowledge.search;
  const entries = client.knowledge;
  const searchQuery = useMemo(
    () => ({
      query: queryText,
      ...(tagFilter.trim() ? { tag: tagFilter.trim() } : {}),
      includeArchived,
      limit: 50,
      maxChars: 50_000,
    }),
    [includeArchived, queryText, tagFilter],
  );
  const results = useInfiniteQuery({
    queryKey: ["knowledge", "search", queryText, tagFilter, includeArchived, searchGeneration],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      search({ ...searchQuery, ...(pageParam === undefined ? {} : { cursor: pageParam }) }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const detail = useQuery({
    queryKey: ["knowledge", "entry", selectedId],
    queryFn: () => readFullEntry(entries, selectedId!),
    enabled: Boolean(selectedId),
  });
  const history = useQuery({
    queryKey: ["knowledge", "history", selectedId],
    queryFn: () => entries.history(selectedId!, undefined, 50),
    enabled: Boolean(selectedId && showHistory),
  });
  const hits = results.data?.pages.flatMap((page) => page.hits) ?? [];
  const hasSearchError = Boolean(results.error);
  const currentEntry = detail.data;

  useEffect(() => {
    if (!draft) return;
    setSelectedId(null);
    setEditing(true);
    setDirty(false);
    setHistoryNotice("来源已固定为 Record 版本；请编辑并确认后再保存。");
    setForm({
      ...emptyForm(),
      title: draft.title,
      slug: slugFromName(draft.title),
      summary: draft.summary,
      bodyMarkdown: draft.bodyMarkdown,
      sourceRefs: draft.sourceRefs,
    });
    onDraftConsumed?.();
  }, [draft, onDraftConsumed]);

  useEffect(() => {
    if (!selectedId || !detail.data || editing || dirty) return;
    setForm(formFromEntry(detail.data));
  }, [detail.data, dirty, editing, selectedId]);

  useEffect(() => {
    if (selectedId || !hits.length || editing) return;
    setSelectedId(hits[0]!.id);
  }, [editing, hits, selectedId]);

  const save = useMutation({
    mutationFn: () => {
      const fingerprint = JSON.stringify({
        id: form.id ?? null,
        expectedVersion: form.id ? form.version : 0,
        expectedRevisionId: form.id ? (form.revisionId ?? null) : null,
        slug: form.slug,
        title: form.title,
        summary: form.summary,
        useWhen: form.useWhen,
        tags: form.tags,
        aliases: form.aliases,
        appliesTo: form.appliesTo,
        bodyMarkdown: form.bodyMarkdown,
        sourceRefs: form.sourceRefs,
      });
      if (!saveOperation.current || saveOperation.current.fingerprint !== fingerprint) {
        saveOperation.current = { fingerprint, opId: `ui-knowledge-${crypto.randomUUID()}` };
      }
      const input: KnowledgeSaveInput = {
        opId: saveOperation.current.opId,
        expectedVersion: form.id ? form.version : 0,
        ...(form.id === undefined || form.revisionId === undefined
          ? {}
          : { expectedRevisionId: form.revisionId }),
        ...(form.id === undefined ? {} : { id: form.id }),
        slug: form.slug,
        title: form.title,
        summary: form.summary,
        useWhen: form.useWhen,
        tags: form.tags,
        aliases: form.aliases,
        appliesTo: form.appliesTo,
        bodyMarkdown: form.bodyMarkdown,
        sourceRefs: form.sourceRefs,
      };
      return entries.save(input);
    },
    onSuccess: async (entry) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["knowledge", "search"] }),
        queryClient.invalidateQueries({ queryKey: ["knowledge", "entry", entry.id] }),
        queryClient.invalidateQueries({ queryKey: ["knowledge", "history", entry.id] }),
      ]);
      setSelectedId(entry.id);
      setForm(formFromEntry(entry));
      setDirty(false);
      setEditing(false);
      setHistoryNotice("");
      saveOperation.current = null;
      notify(form.id ? "知识修订已保存" : "知识条目已创建");
    },
  });
  const archive = useMutation({
    mutationFn: () => {
      if (!form.id || !form.revisionId) throw new Error("当前知识缺少不可变修订标识，请重新读取");
      const fingerprint = JSON.stringify({
        id: form.id,
        expectedVersion: form.version,
        expectedRevisionId: form.revisionId ?? null,
        archived: !form.archived,
      });
      if (!archiveOperation.current || archiveOperation.current.fingerprint !== fingerprint) {
        archiveOperation.current = {
          fingerprint,
          opId: `ui-knowledge-archive-${crypto.randomUUID()}`,
        };
      }
      return entries.archive({
        id: form.id,
        opId: archiveOperation.current.opId,
        expectedVersion: form.version,
        expectedRevisionId: form.revisionId,
        archived: !form.archived,
      });
    },
    onSuccess: async (entry) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["knowledge", "search"] }),
        queryClient.invalidateQueries({ queryKey: ["knowledge", "entry", entry.id] }),
      ]);
      setForm(formFromEntry(entry));
      setDirty(false);
      archiveOperation.current = null;
      notify(entry.archived ? "知识条目已归档" : "知识条目已恢复");
    },
  });

  const updateField = <K extends keyof KnowledgeForm>(key: K, value: KnowledgeForm[K]) => {
    setDirty(true);
    setForm((current) => ({ ...current, [key]: value }));
  };
  const selectEntryNow = (id: string) => {
    setSelectedId(id);
    setEditing(false);
    setDirty(false);
    setShowHistory(false);
    setHistoryNotice("");
  };
  const selectEntry = (id: string) => {
    if (editing && (dirty || !form.id)) {
      setPendingNavigation({ kind: "select", id });
      setHistoryNotice("当前草稿尚未保存；请选择继续编辑或放弃草稿后切换。");
      return;
    }
    selectEntryNow(id);
  };
  const createDraft = () => {
    setSelectedId(null);
    setForm(emptyForm());
    setEditing(true);
    setDirty(false);
    setShowHistory(false);
    setHistoryNotice("新条目尚未保存；关闭或切换前请先保存草稿。");
  };
  const startCreate = () => {
    if (editing && (dirty || !form.id)) {
      setPendingNavigation({ kind: "create" });
      setHistoryNotice("当前草稿尚未保存；请选择继续编辑或放弃草稿后新建。");
      return;
    }
    createDraft();
  };
  const loadImportedFile = async (file: File) => {
    const imported = importedMarkdown(await file.text());
    const metadata = imported.metadata;
    setSelectedId(null);
    setEditing(true);
    setDirty(false);
    setShowHistory(false);
    setHistoryNotice("Markdown 已载入草稿；请补充元数据并确认保存。");
    setForm({
      ...emptyForm(),
      slug: metadata.slug ?? slugFromName(file.name),
      title: metadata.title ?? file.name.replace(/\.[^.]+$/u, ""),
      summary: metadata.summary ?? "",
      useWhen: metadata.useWhen ?? "",
      tags: metadata.tags ?? [],
      aliases: metadata.aliases ?? [],
      appliesTo: metadata.appliesTo ?? [],
      bodyMarkdown: imported.bodyMarkdown,
      sourceRefs: [...(metadata.sourceRefs ?? []), { type: "file", reference: file.name }],
    });
  };
  const importFile = async (file: File) => {
    if (editing && (dirty || !form.id)) {
      setPendingNavigation({ kind: "import", file });
      setHistoryNotice("当前草稿尚未保存；请选择继续编辑或放弃草稿后导入。");
      return;
    }
    await loadImportedFile(file);
  };
  const loadRevision = async (revisionId: string) => {
    if (!currentEntry) return;
    try {
      const old = await readFullEntry(entries, currentEntry.id, revisionId);
      setForm({
        ...formFromEntry(old),
        // Historical content is a draft, but its save must target the head that
        // was visible when the user chose it. The old revisionId is not a valid
        // optimistic-lock baseline and could reintroduce ABA after restore.
        version: currentEntry.version,
        revisionId: currentEntry.revisionId,
        archived: currentEntry.archived,
      });
      setEditing(true);
      setDirty(false);
      setShowHistory(false);
      setPendingNavigation(null);
      setHistoryNotice(
        `已载入修订 v${old.revision} 的草稿；保存会创建新的当前修订，不会覆盖历史。`,
      );
    } catch (error) {
      notify(`无法载入修订：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const requestLoadRevision = (revisionId: string) => {
    if (editing && (dirty || !form.id)) {
      setPendingNavigation({ kind: "revision", revisionId });
      setHistoryNotice("当前草稿尚未保存；请选择继续编辑或放弃草稿后载入历史。");
      return;
    }
    void loadRevision(revisionId);
  };
  const discardAndContinue = () => {
    const pending = pendingNavigation;
    setPendingNavigation(null);
    setEditing(false);
    setDirty(false);
    setHistoryNotice("");
    if (!pending) {
      setForm(emptyForm());
      return;
    }
    if (pending.kind === "select") selectEntryNow(pending.id);
    else if (pending.kind === "create") createDraft();
    else if (pending.kind === "import") void loadImportedFile(pending.file);
    else void loadRevision(pending.revisionId);
  };

  return (
    <>
      <PageHead
        title="知识库"
        description="跨项目共享的本地 Markdown 知识。正文按需读取，归档条目不会出现在默认搜索中。"
        actions={
          <>
            <button className="atm-button primary" type="button" onClick={startCreate}>
              <Plus size={16} />
              新建
            </button>
            <label className="atm-button" title="从本地 Markdown 文件创建可编辑草稿">
              <FileArrowUp size={16} />
              导入 Markdown
              <input
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                className="atm-visually-hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importFile(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <button
              className="atm-button"
              type="button"
              disabled={!form.title.trim() || !form.bodyMarkdown || save.isPending}
              onClick={() => exportMarkdown(form)}
            >
              <Download size={16} />
              导出 Markdown
            </button>
          </>
        }
      />
      <div className="atm-knowledge-layout">
        <section className="atm-panel atm-knowledge-catalog" aria-label="知识目录">
          <div className="atm-panel-head">
            <div>
              <h2>条目目录</h2>
              <div className="atm-row-sub">按标题、标签、场景和正文关键词检索</div>
            </div>
            <span className="atm-key">{hits.length}</span>
          </div>
          <div className="atm-panel-body atm-knowledge-search">
            <div className="atm-field">
              <label htmlFor="knowledge-search">搜索</label>
              <input
                id="knowledge-search"
                value={queryText}
                placeholder="标题、标签或使用场景"
                onChange={(event) => setQueryText(event.target.value)}
              />
            </div>
            <div className="atm-field">
              <label htmlFor="knowledge-tag-filter">标签筛选</label>
              <input
                id="knowledge-tag-filter"
                value={tagFilter}
                placeholder="例如 sqlite"
                onChange={(event) => setTagFilter(event.target.value)}
              />
            </div>
            <label className="atm-check">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
              />
              <span>包括已归档</span>
            </label>
          </div>
          {results.isLoading ? (
            <LoadingRows count={5} />
          ) : results.error && !hits.length ? (
            <>
              <ErrorState error={results.error} />
              <div className="atm-panel-body">
                <button
                  className="atm-button"
                  type="button"
                  onClick={() => setSearchGeneration((generation) => generation + 1)}
                >
                  重新搜索
                </button>
              </div>
            </>
          ) : hits.length ? (
            <div className="atm-knowledge-list">
              {hits.map((hit) => (
                <button
                  className="atm-knowledge-list-item"
                  type="button"
                  data-selected={selectedId === hit.id ? "true" : "false"}
                  key={hit.id}
                  onClick={() => selectEntry(hit.id)}
                >
                  <span className="atm-row-title">{hit.title}</span>
                  <span className="atm-row-sub">{hit.summary}</span>
                  <span className="atm-knowledge-list-meta">
                    {hit.tags.length ? displayList(hit.tags) : "无标签"} · v{hit.revision}
                    {hit.archived ? " · 已归档" : ""}
                  </span>
                </button>
              ))}
              {hasSearchError ? (
                <div className="atm-panel-body">
                  <MutationErrorAlert
                    error={results.error}
                    prefix="后续页加载失败，已保留当前结果："
                  />
                  <button
                    className="atm-button"
                    type="button"
                    onClick={() => setSearchGeneration((generation) => generation + 1)}
                  >
                    从首页重新搜索
                  </button>
                </div>
              ) : null}
              {results.hasNextPage ? (
                <div className="atm-panel-body">
                  <button
                    className="atm-button"
                    type="button"
                    disabled={results.isFetchingNextPage}
                    onClick={() => void results.fetchNextPage()}
                  >
                    {results.isFetchingNextPage ? "加载更多中…" : "加载更多知识"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <Empty
              title="还没有匹配知识"
              text="创建条目或从 Markdown 导入一个可编辑草稿。"
              action={
                <button className="atm-button primary" type="button" onClick={startCreate}>
                  <Plus size={16} />
                  新建知识
                </button>
              }
            />
          )}
        </section>
        <section className="atm-panel atm-knowledge-detail" aria-label="知识详情">
          {editing ? (
            <KnowledgeEditor
              form={form}
              pending={save.isPending}
              onChange={updateField}
              onSave={() => save.mutate()}
              onCancel={() => {
                if (pendingNavigation) {
                  discardAndContinue();
                  return;
                }
                if (form.id && detail.data) {
                  setForm(formFromEntry(detail.data));
                  setEditing(false);
                  setDirty(false);
                  setHistoryNotice("");
                } else {
                  setForm(emptyForm());
                  setEditing(false);
                  setDirty(false);
                  setHistoryNotice("");
                }
              }}
              error={save.error}
              notice={historyNotice}
              discardPrompt={pendingNavigation !== null}
              onKeepDraft={() => {
                setPendingNavigation(null);
                setHistoryNotice("已保留当前草稿。");
              }}
              onDiscardDraft={discardAndContinue}
            />
          ) : currentEntry ? (
            <KnowledgeDetail
              entry={currentEntry}
              showHistory={showHistory}
              history={history.data?.revisions ?? []}
              historyLoading={history.isLoading}
              historyError={history.error}
              onEdit={() => {
                setEditing(true);
                setDirty(false);
                setHistoryNotice("");
              }}
              onArchive={() => archive.mutate()}
              onCopyReference={async () => {
                const reference = `${currentEntry.id}@${currentEntry.revisionId}`;
                try {
                  if (!navigator.clipboard) throw new Error("当前环境不支持剪贴板");
                  await navigator.clipboard.writeText(reference);
                  notify("已复制固定知识引用");
                } catch (error) {
                  notify(`复制引用失败：${error instanceof Error ? error.message : String(error)}`);
                }
              }}
              onToggleHistory={() => setShowHistory((value) => !value)}
              onLoadRevision={requestLoadRevision}
              archivePending={archive.isPending}
              archiveError={archive.error}
              notice={historyNotice}
            />
          ) : (
            <Empty title="选择一个知识条目" text="左侧目录显示当前数据根中的共享知识。" />
          )}
        </section>
      </div>
    </>
  );
}
