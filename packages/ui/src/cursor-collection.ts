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
  /** 这份数据属于哪个 query key。归属写在数据上，不靠「哪次请求跑过」推断。 */
  owner: string;
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

function emptyEntry<T>(owner: string): InternalEntry<T> {
  return {
    owner,
    items: [],
    hasMore: true,
    loading: false,
    error: null,
    cursor: undefined,
    seenCursors: [],
  };
}

/**
 * 一个 key 一个代数。
 *
 * 以前整个 hook 共用一个计数器：切到别的项目时，上一个项目还没读完的那一轮会被判成
 * 作废，半途收工。它既写不进界面，又占着 React Query 里那个 key 的成功结果位——
 * 缓存下来的是一份 items=[]、loading=true 的假成功，3 秒新鲜期内切回去就是一片空白。
 * 切换 key 本来就不该作废另一个 key 的读取：让它读完，缓存里留下的才是真数据。
 * 界面不会被它污染，commit 只认归属于当前 key 的那一份。
 */
export function nextGeneration(generations: Map<string, number>, key: string): number {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return generation;
}

export function isActive(
  generations: Map<string, number>,
  key: string,
  generation: number,
): boolean {
  return (generations.get(key) ?? 0) === generation;
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
      owner: previous.owner,
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
    owner: previous.owner,
    items: outcome.state.items,
    hasMore: true,
    loading: false,
    error: outcome.error,
    cursor: outcome.state.cursor,
    seenCursors: outcome.state.seenCursors,
  };
}

/**
 * 一轮读取交给缓存的结果。
 *
 * 真被同一个 key 的新一轮取代时（续读被重读顶掉、hook 被停用），交回上一份已结算的
 * 数据，绝不能把加载中的占位当成结果：React Query 会把它当成功数据缓存起来，
 * 下次命中的就是一份「空列表 + 正在加载」的假结果。
 */
export function cursorFetchResult<T>(
  outcome: DrainOutcome<T>,
  previous: InternalEntry<T>,
  refreshing: boolean,
): InternalEntry<T> {
  if (outcome.ok === "stale") return { ...previous, loading: false };
  return settledEntry(outcome, previous, refreshing);
}

/**
 * 挑出属于当前 key 的那一份数据：本地提交的优先，其次是 React Query 缓存里的。
 *
 * 归属以前记在一个 ref 上，只在 queryFn 真的执行时才切换。而全局策略 staleTime 是
 * 3 秒：项目 A→B→A 在这段时间内切回来会命中新鲜缓存、根本不跑 queryFn，于是归属
 * 停在 B，连 A 自己的缓存都被拒之门外——列表卡在空白加载态，直到下一次网络刷新。
 */
export function pickOwnedEntry<T>(
  key: string,
  ...candidates: (InternalEntry<T> | null | undefined)[]
): InternalEntry<T> | null {
  for (const candidate of candidates) if (candidate && candidate.owner === key) return candidate;
  return null;
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
  const generationsRef = useRef(new Map<string, number>());
  const entryRef = useRef<InternalEntry<T>>(emptyEntry<T>(key));
  // 当前正在显示哪个 key。切换项目时不能拿上一个项目的列表「保留着」刷新，
  // 也不能让上一个 key 迟到的请求写进当前视图。
  const keyRef = useRef(key);
  keyRef.current = key;
  const [entry, setEntry] = useState<InternalEntry<T>>(entryRef.current);

  const commit = useCallback((next: InternalEntry<T>) => {
    if (next.owner !== keyRef.current) return;
    entryRef.current = next;
    setEntry(next);
  }, []);

  const query = useQuery<InternalEntry<T>>({
    queryKey,
    enabled,
    queryFn: async () => {
      const generation = nextGeneration(generationsRef.current, key);
      // 这一轮读谁，开跑时就定死：它可能跨过一次项目切换才读完，而 loadRef 每次渲染
      // 都会指向当前项目的读取函数——翻下一页时再去取，取到的是别人的列表。
      const load = loadRef.current;
      const current = pickOwnedEntry(key, entryRef.current) ?? emptyEntry<T>(key);
      const resume = Boolean(current.error && current.hasMore && current.items.length);
      const refreshing = !resume && current.items.length > 0;
      // 加载中的占位只发给界面，不作为这一轮的返回值：切走之后这次结果仍然要写进
      // 本 key 的缓存，好让下次切回来立刻有数据，但不能写进别的 key 的视图。
      if (resume) commit({ ...current, loading: true, error: null });
      else if (!refreshing) commit({ ...emptyEntry<T>(key), loading: true });
      const outcome = await drainCursorPages(startState(resume ? current : null), load, () =>
        isActive(generationsRef.current, key, generation),
      );
      const settled = cursorFetchResult(outcome, current, refreshing);
      commit(settled);
      return settled;
    },
  });

  // 命中新鲜缓存时 queryFn 不会执行，数据只能从这里接管。
  useEffect(() => {
    const owned = pickOwnedEntry(key, query.data);
    if (!owned || owned === entryRef.current) return;
    entryRef.current = owned;
    setEntry(owned);
  }, [key, query.data]);

  useEffect(() => {
    if (enabled) return () => undefined;
    const generations = generationsRef.current;
    nextGeneration(generations, key);
    const next = emptyEntry<T>(key);
    next.hasMore = false;
    entryRef.current = next;
    setEntry(next);
    return () => {
      nextGeneration(generations, key);
    };
  }, [enabled, key]);

  const { refetch } = query;
  const retry = useCallback(async () => {
    const current = entryRef.current;
    if (!current.error) return;
    // 没有可续读的 cursor（刷新失败、保留旧列表）时重新整次刷新。
    if (!current.hasMore) return refetch();
    // 续读不推进代数：它接着当前这一轮往下读，不该把正在跑的那一轮作废。
    const generation = generationsRef.current.get(key) ?? 0;
    const load = loadRef.current;
    commit({ ...current, loading: true, error: null });
    const outcome = await drainCursorPages(startState(current), load, () =>
      isActive(generationsRef.current, key, generation),
    );
    commit(cursorFetchResult(outcome, current, false));
  }, [commit, key, refetch]);

  // key 刚变、新一轮读取还没开始的那一帧，不把上一个 key 的数据当成当前数据显示；
  // 但属于这个 key 的缓存要立刻用上，不必等 queryFn 跑。
  const visible = pickOwnedEntry(key, entry, query.data) ?? {
    ...emptyEntry<T>(key),
    loading: enabled,
  };
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
      else if (!refreshing) commit(projectKey, { ...emptyEntry<T>(projectKey), loading: true });
      const outcome = await drainCursorPages(
        startState(resume ? current : null),
        (cursor) => source.loadPage(cursor),
        () => generationRef.current === generation,
      );
      // 这一轮作废时也要落回已结算的那一份：queryFn 返回的就是这张表，
      // 留着 loading 占位同样会被缓存成一次「空列表」的成功结果。
      commit(
        projectKey,
        cursorFetchResult(outcome, current ?? emptyEntry<T>(projectKey), refreshing),
      );
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
    Object.entries(entries)
      // 已不在来源里的项目（归档、删除）不再显示，不必等下一次 queryFn 清理。
      .filter(([projectKey]) => sourcesRef.current.has(projectKey))
      .map(([projectKey, entry]) => [
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
