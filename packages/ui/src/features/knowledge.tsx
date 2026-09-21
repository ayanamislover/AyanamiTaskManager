import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import type { AyanamiClient, KnowledgeSaveInput } from "@ayanami-task/client";
import { Empty, ErrorState, LoadingRows, MutationErrorAlert } from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import { KnowledgeDetail } from "./knowledge-detail.js";
import { KnowledgeEditor } from "./knowledge-editor.js";
import { KnowledgeActions } from "./knowledge-actions.js";
import {
  emptyForm,
  formFromEntry,
  importedMarkdown,
  KNOWLEDGE_SOURCE_LIMIT,
  mergeImportedFileSource,
  readFullEntry,
  displayList,
  slugFromName,
  type KnowledgeDraftSeed,
  type KnowledgeForm,
  type PendingNavigation,
} from "./knowledge-support.js";
import type { KnowledgeSaveOverrides } from "./knowledge-editor.js";

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
  const [pendingImportedFileSource, setPendingImportedFileSource] = useState<string | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const [searchGeneration, setSearchGeneration] = useState(0);
  const saveOperation = useRef<{ fingerprint: string; opId: string } | null>(null);
  const archiveOperation = useRef<{ fingerprint: string; opId: string } | null>(null);
  const navigationEpoch = useRef(0);
  const search = client.knowledge.search;
  const entries = client.knowledge;
  const invalidateNavigation = () => {
    navigationEpoch.current += 1;
    return navigationEpoch.current;
  };
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
  const history = useInfiniteQuery({
    queryKey: ["knowledge", "history", selectedId],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => entries.history(selectedId!, pageParam, 50),
    getNextPageParam: (lastPage) => lastPage.nextRevision ?? undefined,
    enabled: Boolean(selectedId && showHistory),
  });
  const hits = results.data?.pages.flatMap((page) => page.hits) ?? [];
  const hasSearchError = Boolean(results.error);
  const currentEntry = detail.data;
  const historyRevisions = history.data?.pages.flatMap((page) => page.revisions) ?? [];

  useEffect(() => {
    if (!selectedId || !detail.data || editing || dirty) return;
    setForm(formFromEntry(detail.data));
  }, [detail.data, dirty, editing, selectedId]);

  useEffect(() => {
    if (selectedId || !hits.length || editing) return;
    setSelectedId(hits[0]!.id);
  }, [editing, hits, selectedId]);

  const save = useMutation({
    mutationFn: (overrides: KnowledgeSaveOverrides = {}) => {
      invalidateNavigation();
      const saveForm: KnowledgeForm = { ...form, ...overrides };
      const fingerprint = JSON.stringify({
        id: saveForm.id ?? null,
        expectedVersion: saveForm.id ? saveForm.version : 0,
        expectedRevisionId: saveForm.id ? (saveForm.revisionId ?? null) : null,
        slug: saveForm.slug,
        title: saveForm.title,
        summary: saveForm.summary,
        useWhen: saveForm.useWhen,
        tags: saveForm.tags,
        aliases: saveForm.aliases,
        appliesTo: saveForm.appliesTo,
        bodyMarkdown: saveForm.bodyMarkdown,
        sourceRefs: saveForm.sourceRefs,
      });
      if (!saveOperation.current || saveOperation.current.fingerprint !== fingerprint) {
        saveOperation.current = { fingerprint, opId: `ui-knowledge-${crypto.randomUUID()}` };
      }
      const input: KnowledgeSaveInput = {
        opId: saveOperation.current.opId,
        expectedVersion: saveForm.id ? saveForm.version : 0,
        ...(saveForm.id === undefined || saveForm.revisionId === undefined
          ? {}
          : { expectedRevisionId: saveForm.revisionId }),
        ...(saveForm.id === undefined ? {} : { id: saveForm.id }),
        slug: saveForm.slug,
        title: saveForm.title,
        summary: saveForm.summary,
        useWhen: saveForm.useWhen,
        tags: saveForm.tags,
        aliases: saveForm.aliases,
        appliesTo: saveForm.appliesTo,
        bodyMarkdown: saveForm.bodyMarkdown,
        sourceRefs: saveForm.sourceRefs,
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
      setPendingImportedFileSource(null);
      setEditing(false);
      setHistoryNotice("");
      saveOperation.current = null;
      notify(form.id ? "知识修订已保存" : "知识条目已创建");
    },
  });
  const archive = useMutation({
    mutationFn: () => {
      invalidateNavigation();
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

  useEffect(() => {
    if (!draft || save.isPending) return;
    navigationEpoch.current += 1;
    setSelectedId(null);
    setEditing(true);
    setDirty(false);
    setPendingImportedFileSource(null);
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
  }, [draft, onDraftConsumed, save.isPending]);

  const updateField = <K extends keyof KnowledgeForm>(key: K, value: KnowledgeForm[K]) => {
    if (save.isPending) return;
    invalidateNavigation();
    setDirty(true);
    setForm((current) => ({ ...current, [key]: value }));
  };
  const selectEntryNow = (id: string) => {
    if (save.isPending) return;
    invalidateNavigation();
    setSelectedId(id);
    setEditing(false);
    setDirty(false);
    setShowHistory(false);
    setHistoryNotice("");
  };
  const selectEntry = (id: string) => {
    if (save.isPending) return;
    if (editing && (dirty || !form.id)) {
      setPendingNavigation({ kind: "select", id });
      setHistoryNotice("当前草稿尚未保存；请选择继续编辑或放弃草稿后切换。");
      return;
    }
    selectEntryNow(id);
  };
  const createDraft = () => {
    if (save.isPending) return;
    invalidateNavigation();
    setSelectedId(null);
    setForm(emptyForm());
    setEditing(true);
    setDirty(false);
    setPendingImportedFileSource(null);
    setShowHistory(false);
    setHistoryNotice("新条目尚未保存；关闭或切换前请先保存草稿。");
  };
  const startCreate = () => {
    if (save.isPending) return;
    if (editing && (dirty || !form.id)) {
      setPendingNavigation({ kind: "create" });
      setHistoryNotice("当前草稿尚未保存；请选择继续编辑或放弃草稿后新建。");
      return;
    }
    createDraft();
  };
  const loadImportedFile = async (file: File) => {
    if (save.isPending) return;
    const operation = invalidateNavigation();
    const imported = importedMarkdown(await file.text());
    if (operation !== navigationEpoch.current || save.isPending) return;
    const metadata = imported.metadata;
    const sourceMerge = mergeImportedFileSource(metadata.sourceRefs ?? [], file.name);
    setSelectedId(null);
    setEditing(true);
    setDirty(false);
    setShowHistory(false);
    setPendingImportedFileSource(sourceMerge.outcome === "at-capacity" ? file.name : null);
    setHistoryNotice(
      sourceMerge.outcome === "added"
        ? "Markdown 已载入草稿；请补充元数据并确认保存。"
        : sourceMerge.outcome === "duplicate"
          ? "Markdown 已载入草稿；文件来源已存在，重复导入不会增加来源。"
          : sourceMerge.sourceRefs.length > KNOWLEDGE_SOURCE_LIMIT
            ? `Markdown 已载入草稿；当前有 ${sourceMerge.sourceRefs.length} 条来源，超过 ${KNOWLEDGE_SOURCE_LIMIT} 条上限，请先删除超额来源。本次导入文件仅作提示，未加入来源。`
            : `Markdown 已载入草稿；原有 ${sourceMerge.sourceRefs.length} 条来源已完整保留，可直接保存。本次导入文件仅作提示，未加入来源。`,
    );
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
      sourceRefs: sourceMerge.sourceRefs,
    });
  };
  const importFile = async (file: File) => {
    if (save.isPending) return;
    if (editing && (dirty || !form.id)) {
      setPendingNavigation({ kind: "import", file });
      setHistoryNotice("当前草稿尚未保存；请选择继续编辑或放弃草稿后导入。");
      return;
    }
    await loadImportedFile(file);
  };
  const loadRevision = async (revisionId: string) => {
    if (save.isPending) return;
    if (!currentEntry) return;
    const operation = invalidateNavigation();
    try {
      const old = await readFullEntry(entries, currentEntry.id, revisionId);
      if (operation !== navigationEpoch.current || save.isPending) return;
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
      setPendingImportedFileSource(null);
      setPendingNavigation(null);
      setHistoryNotice(
        `已载入修订 v${old.revision} 的草稿；保存会创建新的当前修订，不会覆盖历史。`,
      );
    } catch (error) {
      notify(`无法载入修订：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const requestLoadRevision = (revisionId: string) => {
    if (save.isPending) return;
    if (editing && (dirty || !form.id)) {
      setPendingNavigation({ kind: "revision", revisionId });
      setHistoryNotice("当前草稿尚未保存；请选择继续编辑或放弃草稿后载入历史。");
      return;
    }
    void loadRevision(revisionId);
  };
  const discardAndContinue = () => {
    invalidateNavigation();
    const pending = pendingNavigation;
    setPendingNavigation(null);
    setEditing(false);
    setDirty(false);
    setPendingImportedFileSource(null);
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
  const addPendingImportedFileSource = () => {
    if (save.isPending || !pendingImportedFileSource) return;
    const merged = mergeImportedFileSource(form.sourceRefs, pendingImportedFileSource);
    if (merged.outcome === "added") {
      updateField("sourceRefs", merged.sourceRefs);
      setPendingImportedFileSource(null);
      setHistoryNotice("导入文件来源已加入；请确认保存草稿。");
    } else if (merged.outcome === "duplicate") {
      setPendingImportedFileSource(null);
      setHistoryNotice("导入文件来源已存在，未重复添加。");
    }
  };

  return (
    <>
      <KnowledgeActions
        form={form}
        pending={save.isPending}
        onCreate={startCreate}
        onImport={importFile}
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
                  disabled={save.isPending}
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
              onDirty={() => {
                if (!save.isPending) {
                  invalidateNavigation();
                  setDirty(true);
                }
              }}
              onSave={(overrides) => save.mutate(overrides)}
              onRemoveSource={(index) => {
                updateField(
                  "sourceRefs",
                  form.sourceRefs.filter((_, sourceIndex) => sourceIndex !== index),
                );
              }}
              pendingFileSource={pendingImportedFileSource}
              onAddFileSource={addPendingImportedFileSource}
              onCancel={() => {
                if (pendingNavigation) {
                  discardAndContinue();
                  return;
                }
                if (form.id && detail.data) {
                  setForm(formFromEntry(detail.data));
                  setEditing(false);
                  setDirty(false);
                  setPendingImportedFileSource(null);
                  setHistoryNotice("");
                } else {
                  setForm(emptyForm());
                  setEditing(false);
                  setDirty(false);
                  setPendingImportedFileSource(null);
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
              history={historyRevisions}
              historyLoading={history.isLoading}
              historyLoadingMore={history.isFetchingNextPage}
              historyHasMore={history.hasNextPage}
              historyError={history.error}
              onEdit={() => {
                invalidateNavigation();
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
              onToggleHistory={() => {
                if (!save.isPending) setShowHistory((value) => !value);
              }}
              onLoadMoreHistory={() => {
                void history.fetchNextPage();
              }}
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
