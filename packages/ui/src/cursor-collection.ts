import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AyanamiClientError, type CursorPage } from "@ayanami-task/client";

const MAX_PAGES = 100;
const MAX_ITEMS = 10_000;

export type CursorCollection<T> = {
  items: T[];
  loadedCount: number;
  hasMore: boolean;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  error: unknown;
  retry: () => Promise<unknown>;
};

export type CursorCollectionEntry<T> = CursorCollection<T> & {
  key: string;
  resumeCursor: string | null;
};

export type CursorCollectionSource<T> = {
  key: string;
  loadPage: (cursor?: string) => Promise<CursorPage<T>>;
};

type InternalEntry<T> = {
  items: T[];
  hasMore: boolean;
  loading: boolean;
  error: unknown;
  cursor: string | undefined;
  seenCursors: string[];
};

function errorFor(reason: string, message: string, details: Record<string, unknown> = {}) {
  return new AyanamiClientError({
    code: "INVALID_RESPONSE",
    message,
    status: 502,
    details: { reason, ...details },
  });
}

export type CursorCollectionState<T> = {
  items: T[];
  hasMore: boolean;
  cursor: string | undefined;
  seenCursors: string[];
  pageCount: number;
};

export type CursorPageAdvance<T> =
  | { ok: true; state: CursorCollectionState<T> }
  | { ok: false; state: CursorCollectionState<T>; error: AyanamiClientError };

/**
 * Validate and append one page. Keeping this transition pure makes the
 * retention/retry contract testable without a DOM, and both collection hooks
 * use the same fail-closed rules.
 */
export function advanceCursorPage<T>(
  current: CursorCollectionState<T>,
  page: unknown,
  options: { maxPages?: number; maxItems?: number } = {},
): CursorPageAdvance<T> {
  const maxPages = options.maxPages ?? MAX_PAGES;
  const maxItems = options.maxItems ?? MAX_ITEMS;
  const invalid = (reason: string, message: string, details: Record<string, unknown> = {}) => ({
    ok: false as const,
    state: current,
    error: errorFor(reason, message, details),
  });
  if (current.pageCount >= maxPages) {
    return invalid("DRAIN_LIMIT_REACHED", "分页读取达到安全上限，请使用 resume cursor 继续", {
      maxPages,
      maxItems,
      pageCount: current.pageCount,
      itemCount: current.items.length,
      resumeCursor: current.cursor ?? null,
    });
  }
  if (
    !page ||
    !Array.isArray((page as { items?: unknown }).items) ||
    typeof (page as { hasMore?: unknown }).hasMore !== "boolean"
  ) {
    return invalid("INVALID_PAGE", "分页返回了无效分页响应");
  }
  const typedPage = page as { items: T[]; hasMore: boolean; nextCursor?: unknown };
  const pageCount = current.pageCount + 1;
  if (current.items.length + typedPage.items.length > maxItems) {
    return invalid("DRAIN_LIMIT_REACHED", "分页读取达到安全上限，请使用 resume cursor 继续", {
      maxPages,
      maxItems,
      pageCount,
      itemCount: current.items.length,
      resumeCursor: current.cursor ?? null,
    });
  }
  if (typedPage.hasMore && (typeof typedPage.nextCursor !== "string" || !typedPage.nextCursor)) {
    return invalid("MISSING_NEXT_CURSOR", "分页声明 hasMore=true 但未返回 nextCursor");
  }
  const nextCursor = typedPage.nextCursor as string | undefined;
  if (typedPage.hasMore && nextCursor !== undefined && current.seenCursors.includes(nextCursor)) {
    return invalid("REPEATED_CURSOR", "分页返回了重复 cursor", {
      resumeCursor: current.cursor ?? null,
    });
  }
  const nextState: CursorCollectionState<T> = typedPage.hasMore
    ? {
        items: [...current.items, ...typedPage.items],
        hasMore: true,
        cursor: nextCursor,
        seenCursors: [...current.seenCursors, nextCursor!],
        pageCount,
      }
    : {
        items: [...current.items, ...typedPage.items],
        hasMore: false,
        cursor: undefined,
        seenCursors: [...current.seenCursors],
        pageCount,
      };
  return { ok: true, state: nextState };
}

function emptyEntry<T>(): InternalEntry<T> {
  return {
    items: [],
    hasMore: true,
    loading: false,
    error: null,
    cursor: undefined,
    seenCursors: [],
  };
}

function isActive(generationRef: { current: number }, generation: number): boolean {
  return generationRef.current === generation;
}

type DrainOutcome<T> =
  | { ok: true; state: CursorCollectionState<T> }
  | { ok: false; state: CursorCollectionState<T>; error: unknown }
  | { ok: "stale" };

/**
 * 把剩余分页全部读完，读完之前不碰界面。
 *
 * 以前每读完一页就提交一次：首屏表格按 100→200→300… 分几次长高，而刷新时更糟——
 * 先把已显示的列表清空成骨架屏再一页页重填。全局查询策略每 30 秒、每次窗口聚焦、
 * 每次改完任务都会刷新，列表就周期性地塌下去再长回来，滚动位置也跟着被顶走。
 */
async function drainCursorPages<T>(
  start: CursorCollectionState<T>,
  loadPage: (cursor?: string) => Promise<CursorPage<T>>,
  active: () => boolean,
): Promise<DrainOutcome<T>> {
  let state = start;
  for (;;) {
    if (!active()) return { ok: "stale" };
    if (state.pageCount >= MAX_PAGES) {
      return {
        ok: false,
        state,
        error: errorFor("DRAIN_LIMIT_REACHED", "分页读取达到安全上限，请使用 resume cursor 继续", {
          maxPages: MAX_PAGES,
          maxItems: MAX_ITEMS,
          pageCount: state.pageCount,
          itemCount: state.items.length,
          resumeCursor: state.cursor ?? null,
        }),
      };
    }
    let page: CursorPage<T>;
    try {
      page = await loadPage(state.cursor);
    } catch (error) {
      if (!active()) return { ok: "stale" };
      return { ok: false, state, error };
    }
    if (!active()) return { ok: "stale" };
    const advanced = advanceCursorPage(state, page);
    if (!advanced.ok) return { ok: false, state, error: advanced.error };
    state = advanced.state;
    if (!state.hasMore) return { ok: true, state };
  }
}

function startState<T>(entry: InternalEntry<T> | null): CursorCollectionState<T> {
  return entry
    ? {
        items: [...entry.items],
        hasMore: true,
        cursor: entry.cursor,
        seenCursors: [...entry.seenCursors],
        pageCount: entry.seenCursors.length,
      }
    : { items: [], hasMore: true, cursor: undefined, seenCursors: [], pageCount: 0 };
}

function settledEntry<T>(
  outcome: Exclude<DrainOutcome<T>, { ok: "stale" }>,
  previous: InternalEntry<T>,
  refreshing: boolean,
): InternalEntry<T> {
  if (outcome.ok === true) {
    return {
      items: outcome.state.items,
      hasMore: false,
      loading: false,
      error: null,
      cursor: undefined,
      seenCursors: outcome.state.seenCursors,
    };
  }
  // 刷新失败时保留上一份完整列表，只报错；重试走整次刷新（见 retry）。
  // 首次读取或续读失败时提交已读到的部分和出错的 cursor，重试从断点续读。
  if (refreshing) return { ...previous, loading: false, error: outcome.error };
  return {
    items: outcome.state.items,
    hasMore: true,
    loading: false,
    error: outcome.error,
    cursor: outcome.state.cursor,
    seenCursors: outcome.state.seenCursors,
  };
}

/**
 * Read a cursor collection. The first read shows a skeleton until every page is
 * in; later refreshes keep the current rows on screen and swap in the new list
 * once, so periodic refetches never collapse the view. A failed first read keeps
 * the committed rows and the exact cursor that can be retried.
 */
export function useCursorCollection<T>(
  queryKey: readonly unknown[],
  loadPage: (cursor?: string) => Promise<CursorPage<T>>,
  enabled = true,
): CursorCollection<T> {
  const key = queryKey.map((part) => String(part)).join("\u0000");
  const loadRef = useRef(loadPage);
  loadRef.current = loadPage;
  const generationRef = useRef(0);
  const entryRef = useRef<InternalEntry<T>>(emptyEntry<T>());
  // 当前显示的数据属于哪个 key。切换项目时不能拿上一个项目的列表「保留着」刷新。
  const ownerRef = useRef(key);
  const [entry, setEntry] = useState<InternalEntry<T>>(entryRef.current);

  const commit = useCallback((next: InternalEntry<T>) => {
    entryRef.current = next;
    setEntry(next);
  }, []);

  const query = useQuery<InternalEntry<T>>({
    queryKey,
    enabled,
    queryFn: async () => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      if (ownerRef.current !== key) {
        ownerRef.current = key;
        commit(emptyEntry<T>());
      }
      const current = entryRef.current;
      const resume = Boolean(current.error && current.hasMore && current.items.length);
      const refreshing = !resume && current.items.length > 0;
      if (resume) commit({ ...current, loading: true, error: null });
      else if (!refreshing) commit({ ...emptyEntry<T>(), loading: true });
      const outcome = await drainCursorPages(
        startState(resume ? current : null),
        (cursor) => loadRef.current(cursor),
        () => isActive(generationRef, generation),
      );
      if (outcome.ok !== "stale") commit(settledEntry(outcome, current, refreshing));
      return entryRef.current;
    },
  });

  useEffect(() => {
    if (!query.data || query.data === entryRef.current || ownerRef.current !== key) return;
    entryRef.current = query.data;
    setEntry(query.data);
  }, [key, query.data]);

  useEffect(() => {
    if (enabled) return () => undefined;
    generationRef.current += 1;
    ownerRef.current = key;
    const next = emptyEntry<T>();
    next.hasMore = false;
    entryRef.current = next;
    setEntry(next);
    return () => {
      generationRef.current += 1;
    };
  }, [enabled, key]);

  const { refetch } = query;
  const retry = useCallback(async () => {
    const current = entryRef.current;
    if (!current.error) return;
    // 没有可续读的 cursor（刷新失败、保留旧列表）时重新整次刷新。
    if (!current.hasMore) return refetch();
    const generation = generationRef.current;
    commit({ ...current, loading: true, error: null });
    const outcome = await drainCursorPages(
      startState(current),
      (cursor) => loadRef.current(cursor),
      () => isActive(generationRef, generation),
    );
    if (outcome.ok !== "stale") commit(settledEntry(outcome, current, false));
  }, [commit, refetch]);

  // key 刚变、新一轮读取还没开始的那一帧，不把上一个 key 的数据当成当前数据显示。
  const visible = ownerRef.current === key ? entry : { ...emptyEntry<T>(), loading: enabled };
  return {
    items: visible.items,
    loadedCount: visible.items.length,
    hasMore: visible.hasMore,
    isLoading: visible.loading && visible.items.length === 0,
    isFetchingNextPage: visible.loading && visible.items.length > 0,
    error: visible.error,
    retry,
  };
}

/** The same reader for a dynamic set of project collections. */
export function useCursorCollections<T>(
  queryKey: readonly unknown[],
  sources: CursorCollectionSource<T>[],
): {
  entries: Record<string, CursorCollectionEntry<T>>;
  retry: (key: string) => Promise<unknown>;
} {
  const key = sources.map((source) => source.key).join("\u0000");
  const sourcesRef = useRef(new Map<string, CursorCollectionSource<T>>());
  sourcesRef.current = new Map(sources.map((source) => [source.key, source]));
  const generationRef = useRef(0);
  const entriesRef = useRef<Record<string, InternalEntry<T>>>({});
  const [entries, setEntries] = useState<Record<string, InternalEntry<T>>>({});

  const commit = useCallback((projectKey: string, next: InternalEntry<T>) => {
    const updated = { ...entriesRef.current, [projectKey]: next };
    entriesRef.current = updated;
    setEntries(updated);
  }, []);

  const read = useCallback(
    async (projectKey: string, generation: number, resumeOnly: boolean): Promise<void> => {
      const source = sourcesRef.current.get(projectKey);
      if (!source) return;
      const current = entriesRef.current[projectKey] ?? null;
      const resume = Boolean(current?.error && current.hasMore && current.items.length);
      if (resumeOnly && !resume) return;
      const refreshing = !resume && Boolean(current?.items.length);
      if (resume) commit(projectKey, { ...current!, loading: true, error: null });
      else if (!refreshing) commit(projectKey, { ...emptyEntry<T>(), loading: true });
      const outcome = await drainCursorPages(
        startState(resume ? current : null),
        (cursor) => source.loadPage(cursor),
        () => generationRef.current === generation,
      );
      if (outcome.ok !== "stale")
        commit(projectKey, settledEntry(outcome, current ?? emptyEntry<T>(), refreshing));
    },
    [commit],
  );

  const query = useQuery<Record<string, InternalEntry<T>>>({
    queryKey: [...queryKey, key],
    queryFn: async () => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      // 已不在来源里的项目（归档、删除）从结果里去掉。
      const kept = Object.fromEntries(
        Object.entries(entriesRef.current).filter(([projectKey]) =>
          sourcesRef.current.has(projectKey),
        ),
      );
      entriesRef.current = kept;
      setEntries(kept);
      await Promise.all(sources.map((source) => read(source.key, generation, false)));
      return entriesRef.current;
    },
  });

  useEffect(() => {
    if (!query.data || query.data === entriesRef.current) return;
    entriesRef.current = query.data;
    setEntries(query.data);
  }, [key, query.data]);

  const { refetch } = query;
  const retry = useCallback(
    async (projectKey: string) => {
      const current = entriesRef.current[projectKey];
      if (!current?.error) return;
      if (!current.hasMore) return refetch();
      await read(projectKey, generationRef.current, true);
    },
    [read, refetch],
  );

  const projected = Object.fromEntries(
    Object.entries(entries).map(([projectKey, entry]) => [
      projectKey,
      {
        key: projectKey,
        items: entry.items,
        loadedCount: entry.items.length,
        hasMore: entry.hasMore,
        isLoading: entry.loading && entry.items.length === 0,
        isFetchingNextPage: entry.loading && entry.items.length > 0,
        error: entry.error,
        resumeCursor: entry.cursor ?? null,
        retry: () => retry(projectKey),
      },
    ]),
  ) as Record<string, CursorCollectionEntry<T>>;
  return { entries: projected, retry };
}
