import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon as Archive } from "@phosphor-icons/react/dist/icons/Archive";
import { ArrowCounterClockwiseIcon as Restore } from "@phosphor-icons/react/dist/icons/ArrowCounterClockwise";
import { ClockCounterClockwiseIcon as History } from "@phosphor-icons/react/dist/icons/ClockCounterClockwise";
import { DownloadSimpleIcon as Download } from "@phosphor-icons/react/dist/icons/DownloadSimple";
import { FileArrowUpIcon as FileArrowUp } from "@phosphor-icons/react/dist/icons/FileArrowUp";
import { PencilSimpleIcon as Pencil } from "@phosphor-icons/react/dist/icons/PencilSimple";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import type {
  AyanamiClient,
  KnowledgeEntry,
  KnowledgeGetPage,
  KnowledgeRevision,
  KnowledgeSaveInput,
  KnowledgeSource,
} from "@ayanami-task/client";
import {
  Empty,
  ErrorState,
  LoadingRows,
  MutationErrorAlert,
  PageHead,
} from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import { formatTime } from "../presentation.js";

export type KnowledgeDraftSeed = {
  title: string;
  summary: string;
  bodyMarkdown: string;
  sourceRefs: KnowledgeSource[];
};

type KnowledgeForm = {
  id?: string;
  version: number;
  revisionId?: string;
  archived: boolean;
  slug: string;
  title: string;
  summary: string;
  useWhen: string;
  tags: string[];
  aliases: string[];
  appliesTo: string[];
  bodyMarkdown: string;
  sourceRefs: KnowledgeSource[];
};

type PendingNavigation =
  | { kind: "select"; id: string }
  | { kind: "create" }
  | { kind: "import"; file: File }
  | { kind: "revision"; revisionId: string };

const emptyForm = (): KnowledgeForm => ({
  version: 0,
  archived: false,
  slug: "",
  title: "",
  summary: "",
  useWhen: "",
  tags: [],
  aliases: [],
  appliesTo: [],
  bodyMarkdown: "",
  sourceRefs: [],
});

function formFromEntry(entry: KnowledgeEntry): KnowledgeForm {
  return {
    id: entry.id,
    version: entry.version,
    revisionId: entry.revisionId,
    archived: entry.archived,
    slug: entry.slug,
    title: entry.title,
    summary: entry.summary,
    useWhen: entry.useWhen,
    tags: entry.tags,
    aliases: entry.aliases,
    appliesTo: entry.appliesTo,
    bodyMarkdown: entry.bodyMarkdown,
    sourceRefs: entry.sourceRefs,
  };
}

function listValue(value: string): string[] {
  return value
    .split(/[\n,，]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function displayList(values: string[]): string {
  return values.join("、");
}

function slugFromName(name: string): string {
  const withoutExtension = name.replace(/\.[^.]+$/u, "").trim();
  return withoutExtension
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 160);
}

function exportMarkdown(form: KnowledgeForm): void {
  // JSON front matter keeps newlines, colons, quotes and `---` in user text
  // round-trippable. File references are reduced to their visible basename;
  // the browser cannot expose a local path and exports must not invent one.
  const sourceRefs = form.sourceRefs.map((source) =>
    source.type === "file"
      ? { ...source, reference: source.reference.split(/[\\/]/u).at(-1) ?? source.reference }
      : source,
  );
  const metadata = {
    title: form.title,
    slug: form.slug,
    summary: form.summary,
    useWhen: form.useWhen,
    tags: form.tags,
    aliases: form.aliases,
    appliesTo: form.appliesTo,
    sourceRefs,
  };
  const frontMatter = `---json\n${JSON.stringify(metadata, null, 2)}\n---\n\n`;
  const blob = new Blob([frontMatter, form.bodyMarkdown], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${form.slug || "knowledge"}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function validSourceRefs(value: unknown): KnowledgeSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): KnowledgeSource[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const source = candidate as Record<string, unknown>;
    if (
      !["project_record", "file", "url", "manual"].includes(String(source.type)) ||
      typeof source.reference !== "string" ||
      !source.reference.trim()
    )
      return [];
    const type = source.type as KnowledgeSource["type"];
    const common = { type, reference: source.reference } as KnowledgeSource;
    if (type === "project_record") {
      if (
        typeof source.projectId !== "string" ||
        typeof source.recordId !== "string" ||
        !Number.isInteger(source.sourceVersion) ||
        Number(source.sourceVersion) < 0
      )
        return [];
      return [
        {
          ...common,
          projectId: source.projectId,
          recordId: source.recordId,
          sourceVersion: Number(source.sourceVersion),
        },
      ];
    }
    if (
      source.sourceVersion !== undefined &&
      (!Number.isInteger(source.sourceVersion) || Number(source.sourceVersion) < 0)
    )
      return [];
    return [
      {
        ...common,
        ...(typeof source.sourceVersion === "number"
          ? { sourceVersion: source.sourceVersion }
          : {}),
        ...(typeof source.projectId === "string" ? { projectId: source.projectId } : {}),
        ...(typeof source.recordId === "string" ? { recordId: source.recordId } : {}),
      },
    ];
  });
}

function importedMarkdown(content: string): {
  metadata: Partial<
    Pick<
      KnowledgeForm,
      "title" | "slug" | "summary" | "useWhen" | "tags" | "aliases" | "appliesTo" | "sourceRefs"
    >
  >;
  bodyMarkdown: string;
} {
  const match = /^---json\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u.exec(content);
  if (!match) return { metadata: {}, bodyMarkdown: content };
  try {
    const raw = JSON.parse(match[1]!) as Record<string, unknown>;
    const list = (value: unknown): string[] | undefined =>
      Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
    const tags = list(raw.tags);
    const aliases = list(raw.aliases);
    const appliesTo = list(raw.appliesTo);
    return {
      metadata: {
        ...(typeof raw.title === "string" ? { title: raw.title } : {}),
        ...(typeof raw.slug === "string" ? { slug: raw.slug } : {}),
        ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
        ...(typeof raw.useWhen === "string" ? { useWhen: raw.useWhen } : {}),
        ...(tags === undefined ? {} : { tags }),
        ...(aliases === undefined ? {} : { aliases }),
        ...(appliesTo === undefined ? {} : { appliesTo }),
        ...(Array.isArray(raw.sourceRefs) ? { sourceRefs: validSourceRefs(raw.sourceRefs) } : {}),
      },
      bodyMarkdown: content.slice(match[0].length),
    };
  } catch {
    // Invalid metadata is just Markdown; never discard user content on import.
    return { metadata: {}, bodyMarkdown: content };
  }
}

function sourceLabel(source: KnowledgeSource): string {
  if (source.type === "project_record") {
    return `${source.projectId ?? "项目"} · ${source.reference}${source.sourceVersion === undefined ? "" : ` · v${source.sourceVersion}`}`;
  }
  return `${source.type} · ${source.reference}`;
}

async function readFullEntry(
  entries: AyanamiClient["knowledge"],
  id: string,
  revisionId?: string,
): Promise<KnowledgeGetPage> {
  let page = await entries.get(id, {
    maxChars: 600_000,
    ...(revisionId === undefined ? {} : { revisionId }),
  });
  const firstPage = page;
  const fixedRevision = firstPage.revision;
  const fixedRevisionId = firstPage.revisionId;
  const fixedId = firstPage.id;
  const body = [page.bodyMarkdown];
  const seen = new Set<string>();
  while (page.nextCursor) {
    if (seen.has(page.nextCursor)) throw new Error("知识正文分页游标重复，已停止读取");
    seen.add(page.nextCursor);
    page = await entries.get(id, { cursor: page.nextCursor, maxChars: 600_000 });
    if (
      page.id !== fixedId ||
      page.revision !== fixedRevision ||
      page.revisionId !== fixedRevisionId
    )
      throw new Error("知识正文分页返回了不一致的条目或修订，已停止读取");
    body.push(page.bodyMarkdown);
  }
  return { ...firstPage, bodyMarkdown: body.join(""), truncated: false, nextCursor: null };
}

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

function KnowledgeEditor({
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

function KnowledgeDetail({
  entry,
  showHistory,
  history,
  historyLoading,
  historyError,
  onEdit,
  onArchive,
  onCopyReference,
  onToggleHistory,
  onLoadRevision,
  archivePending,
  archiveError,
  notice,
}: {
  entry: KnowledgeEntry & { toc?: Array<{ id: string; title: string; level: number }> };
  showHistory: boolean;
  history: Array<Omit<KnowledgeRevision, "bodyMarkdown">>;
  historyLoading: boolean;
  historyError: unknown;
  onEdit: () => void;
  onArchive: () => void;
  onCopyReference: () => void | Promise<void>;
  onToggleHistory: () => void;
  onLoadRevision: (revisionId: string) => void | Promise<void>;
  archivePending: boolean;
  archiveError: unknown;
  notice: string;
}) {
  return (
    <>
      <div className="atm-panel-head atm-knowledge-detail-head">
        <div>
          <div className="atm-knowledge-detail-kicker">
            <span className="atm-key">{entry.slug}</span>
            <span className={`atm-badge ${entry.archived ? "warning" : "success"}`}>
              {entry.archived ? "已归档" : "已发布"}
            </span>
          </div>
          <h2>{entry.title}</h2>
          <div className="atm-row-sub">
            修订 v{entry.revision} · 更新于 {formatTime(entry.createdAt)}
          </div>
        </div>
        <div className="atm-actions">
          <button className="atm-button" type="button" onClick={onEdit}>
            <Pencil size={16} />
            编辑
          </button>
          <button className="atm-button" type="button" onClick={() => void onCopyReference()}>
            复制引用
          </button>
          <button className="atm-button" type="button" onClick={onToggleHistory}>
            <History size={16} />
            {showHistory ? "收起历史" : "修订历史"}
          </button>
          <button
            className={`atm-button ${entry.archived ? "" : "danger"}`}
            type="button"
            disabled={archivePending}
            onClick={onArchive}
          >
            {entry.archived ? <Restore size={16} /> : <Archive size={16} />}
            {entry.archived ? "恢复条目" : "归档条目"}
          </button>
        </div>
      </div>
      <div className="atm-panel-body atm-knowledge-detail-body">
        {notice ? (
          <div className="atm-inline-warning" role="status">
            {notice}
          </div>
        ) : null}
        <div className="atm-knowledge-summary-grid">
          <div>
            <div className="atm-row-title">摘要</div>
            <p>{entry.summary}</p>
          </div>
          <div>
            <div className="atm-row-title">使用场景</div>
            <p>{entry.useWhen || "未填写"}</p>
          </div>
        </div>
        <div className="atm-knowledge-meta-grid">
          <div>
            <span>标签</span>
            <strong>{displayList(entry.tags) || "无"}</strong>
          </div>
          <div>
            <span>适用范围</span>
            <strong>{displayList(entry.appliesTo) || "未填写"}</strong>
          </div>
          <div>
            <span>别名</span>
            <strong>{displayList(entry.aliases) || "无"}</strong>
          </div>
        </div>
        {entry.sourceRefs.length ? (
          <div className="atm-knowledge-sources">
            <div className="atm-row-title">来源引用</div>
            {entry.sourceRefs.map((source) => (
              <div className="atm-row-sub" key={`${source.type}:${source.reference}`}>
                {sourceLabel(source)}
              </div>
            ))}
          </div>
        ) : null}
        {entry.toc?.length ? (
          <details className="atm-knowledge-toc">
            <summary>章节目录（{entry.toc.length}）</summary>
            <div>
              {entry.toc.map((heading) => (
                <div key={heading.id} style={{ paddingLeft: Math.max(0, heading.level - 1) * 14 }}>
                  {heading.title}
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <pre className="atm-knowledge-markdown">{entry.bodyMarkdown}</pre>
        {showHistory ? (
          <section className="atm-knowledge-history">
            <h3>修订历史</h3>
            {historyLoading ? <LoadingRows count={2} /> : null}
            {historyError ? <MutationErrorAlert error={historyError} /> : null}
            {!historyLoading && !historyError && !history.length ? (
              <div className="atm-row-sub">暂无更早修订。</div>
            ) : null}
            {history.map((revision) => (
              <div className="atm-knowledge-history-row" key={revision.revision}>
                <div>
                  <strong>
                    v{revision.revision} · {revision.title}
                  </strong>
                  <span>
                    {revision.summary} · {formatTime(revision.createdAt)}
                  </span>
                </div>
                <button
                  className="atm-button"
                  type="button"
                  onClick={() => void onLoadRevision(revision.revisionId)}
                >
                  载入为新修订
                </button>
              </div>
            ))}
          </section>
        ) : null}
        <MutationErrorAlert error={archiveError} />
      </div>
    </>
  );
}
