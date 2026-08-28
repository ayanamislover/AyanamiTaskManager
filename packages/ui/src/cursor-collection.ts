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

/**
 * Read a cursor collection incrementally. Each successful page is committed
 * before the next request, so a later failure keeps the loaded rows and the
 * exact cursor that can be retried.
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
  const [entry, setEntry] = useState<InternalEntry<T>>(entryRef.current);

  const commit = useCallback(
    (next: InternalEntry<T> | ((current: InternalEntry<T>) => InternalEntry<T>)) => {
      setEntry((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        entryRef.current = resolved;
        return resolved;
      });
    },
    [],
  );

  const consume = useCallback(
    async (
      startCursor: string | undefined,
      startItems: T[],
      startSeenCursors: string[],
      generation: number,
    ): Promise<void> => {
      let state: CursorCollectionState<T> = {
        items: [...startItems],
        hasMore: true,
        cursor: startCursor,
        seenCursors: [...startSeenCursors],
        pageCount: startSeenCursors.length,
      };
      commit((current) => ({ ...current, loading: true, error: null, cursor: state.cursor }));
      for (;;) {
        if (!isActive(generationRef, generation)) return;
        if (state.pageCount >= MAX_PAGES) {
          commit((current) => ({
            ...current,
            loading: false,
            error: errorFor(
              "DRAIN_LIMIT_REACHED",
              "分页读取达到安全上限，请使用 resume cursor 继续",
              {
                maxPages: MAX_PAGES,
                maxItems: MAX_ITEMS,
                pageCount: state.pageCount,
                itemCount: state.items.length,
                resumeCursor: state.cursor ?? null,
              },
            ),
            cursor: state.cursor,
          }));
          return;
        }
        let page: CursorPage<T>;
        try {
          page = await loadRef.current(state.cursor);
        } catch (error) {
          if (!isActive(generationRef, generation)) return;
          commit((current) => ({ ...current, loading: false, error, cursor: state.cursor }));
          return;
        }
        const advanced = advanceCursorPage(state, page);
        if (!advanced.ok) {
          commit((current) => ({
            ...current,
            loading: false,
            error: advanced.error,
            cursor: state.cursor,
          }));
          return;
        }
        state = advanced.state;
        if (!state.hasMore) {
          commit({
            items: state.items,
            hasMore: false,
            loading: false,
            error: null,
            cursor: undefined,
            seenCursors: state.seenCursors,
          });
          return;
        }
        commit({
          items: state.items,
          hasMore: true,
          loading: true,
          error: null,
          cursor: state.cursor,
          seenCursors: state.seenCursors,
        });
      }
    },
    [commit],
  );

  useQuery({
    queryKey,
    enabled,
    queryFn: async () => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const current = entryRef.current;
      const resume = Boolean(current.error && current.hasMore);
      if (!resume) {
        const initial = emptyEntry<T>();
        initial.loading = true;
        entryRef.current = initial;
        setEntry(initial);
      }
      await consume(
        resume ? current.cursor : undefined,
        resume ? current.items : [],
        resume ? current.seenCursors : [],
        generation,
      );
      return generation;
    },
  });

  useEffect(() => {
    if (enabled) return () => undefined;
    generationRef.current += 1;
    const next = emptyEntry<T>();
    next.hasMore = false;
    entryRef.current = next;
    setEntry(next);
    return () => {
      generationRef.current += 1;
    };
  }, [enabled, key]);

  const retry = useCallback(async () => {
    const current = entryRef.current;
    if (!current.error) return;
    const generation = generationRef.current;
    await consume(current.cursor, current.items, current.seenCursors, generation);
  }, [consume]);

  return {
    items: entry.items,
    loadedCount: entry.items.length,
    hasMore: entry.hasMore,
    isLoading: entry.loading && entry.items.length === 0,
    isFetchingNextPage: entry.loading && entry.items.length > 0,
    error: entry.error,
    retry,
  };
}

/** The same incremental reader for a dynamic set of project collections. */
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

  const commit = useCallback(
    (
      projectKey: string,
      next: InternalEntry<T> | ((current: InternalEntry<T>) => InternalEntry<T>),
    ) => {
      setEntries((current) => {
        const previous = current[projectKey] ?? emptyEntry<T>();
        const resolved = typeof next === "function" ? next(previous) : next;
        const updated = { ...current, [projectKey]: resolved };
        entriesRef.current = updated;
        return updated;
      });
    },
    [],
  );

  const consume = useCallback(
    async (
      projectKey: string,
      startCursor: string | undefined,
      startItems: T[],
      startSeenCursors: string[],
      generation: number,
    ): Promise<void> => {
      const source = sourcesRef.current.get(projectKey);
      if (!source) return;
      let state: CursorCollectionState<T> = {
        items: [...startItems],
        hasMore: true,
        cursor: startCursor,
        seenCursors: [...startSeenCursors],
        pageCount: startSeenCursors.length,
      };
      commit(projectKey, (current) => ({
        ...current,
        loading: true,
        error: null,
        cursor: state.cursor,
      }));
      for (;;) {
        if (generationRef.current !== generation) return;
        if (state.pageCount >= MAX_PAGES) {
          commit(projectKey, (current) => ({
            ...current,
            loading: false,
            error: errorFor(
              "DRAIN_LIMIT_REACHED",
              "分页读取达到安全上限，请使用 resume cursor 继续",
              {
                maxPages: MAX_PAGES,
                maxItems: MAX_ITEMS,
                pageCount: state.pageCount,
                itemCount: state.items.length,
                resumeCursor: state.cursor ?? null,
              },
            ),
            cursor: state.cursor,
          }));
          return;
        }
        let page: CursorPage<T>;
        try {
          page = await source.loadPage(state.cursor);
        } catch (error) {
          if (generationRef.current !== generation) return;
          commit(projectKey, (current) => ({
            ...current,
            loading: false,
            error,
            cursor: state.cursor,
          }));
          return;
        }
        const advanced = advanceCursorPage(state, page);
        if (!advanced.ok) {
          commit(projectKey, (current) => ({
            ...current,
            loading: false,
            error: advanced.error,
            cursor: state.cursor,
          }));
          return;
        }
        state = advanced.state;
        if (!state.hasMore) {
          commit(projectKey, {
            items: state.items,
            hasMore: false,
            loading: false,
            error: null,
            cursor: undefined,
            seenCursors: state.seenCursors,
          });
          return;
        }
        commit(projectKey, {
          items: state.items,
          hasMore: true,
          loading: true,
          error: null,
          cursor: state.cursor,
          seenCursors: state.seenCursors,
        });
      }
    },
    [commit],
  );

  useQuery({
    queryKey: [...queryKey, key],
    queryFn: async () => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const initial: Record<string, InternalEntry<T>> = {};
      for (const source of sources) {
        const previous = entriesRef.current[source.key];
        initial[source.key] =
          previous?.error && previous.hasMore
            ? { ...previous, loading: true, error: null }
            : { ...emptyEntry<T>(), loading: true };
      }
      entriesRef.current = initial;
      setEntries(initial);
      await Promise.all(
        sources.map((source) => {
          const entry = initial[source.key]!;
          return consume(source.key, entry.cursor, entry.items, entry.seenCursors, generation);
        }),
      );
      return generation;
    },
  });

  const retry = useCallback(
    async (projectKey: string) => {
      const current = entriesRef.current[projectKey];
      if (!current?.error) return;
      await consume(
        projectKey,
        current.cursor,
        current.items,
        current.seenCursors,
        generationRef.current,
      );
    },
    [consume],
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
