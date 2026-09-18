import { useEffect } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";

/** 默认只显示最近结束的几项；其余点「加载更多」按页往下取。 */
export const RECENT_CLOSED_FIRST_PAGE = 5;
export const RECENT_CLOSED_NEXT_PAGE = 50;

export type RecentClosedTasks = {
  items: any[];
  /** 已结束任务总数，包括还没加载的。 */
  total: number;
  hasMore: boolean;
  isLoading: boolean;
  isFetchingMore: boolean;
  error: unknown;
  loadMore: () => void;
};

type ClosedPage = { items: any[]; nextCursor?: string | null; hasMore: boolean; total: number };

/**
 * 已结束任务按结束时间倒序、按需分页。
 *
 * 一个项目的任务绝大多数是已结束的（实测 ATM 项目 361 个里 353 个），以前全量拉下来和
 * 进行中的任务混排渲染，是首屏抽动的主要来源。loadAll 用于用户明确筛选「已完成 /
 * 已取消」的场景：那时只显示已加载的几项是错的，要把剩下的都取回来。
 */
export function useRecentClosedTasks(
  client: AyanamiClient,
  project: string,
  loadAll: boolean,
): RecentClosedTasks {
  const query = useInfiniteQuery({
    queryKey: ["tasks", project, "ui", "closed"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      client.tasks.recentClosedPageForUi(
        project,
        pageParam
          ? { limit: RECENT_CLOSED_NEXT_PAGE, cursor: pageParam }
          : { limit: RECENT_CLOSED_FIRST_PAGE },
      ) as Promise<ClosedPage>,
    getNextPageParam: (last: ClosedPage) =>
      last.hasMore && last.nextCursor ? last.nextCursor : undefined,
  });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  useEffect(() => {
    if (loadAll && hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [loadAll, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  const pages = query.data?.pages ?? [];
  const seen = new Set<string>();
  const items = pages
    .flatMap((page) => page.items)
    .filter((task) => {
      if (seen.has(task.key)) return false;
      seen.add(task.key);
      return true;
    });
  return {
    items,
    total: pages.at(-1)?.total ?? 0,
    hasMore: Boolean(hasNextPage),
    isLoading: query.isLoading,
    isFetchingMore: isFetchingNextPage,
    error: query.error,
    loadMore: () => void fetchNextPage(),
  };
}
