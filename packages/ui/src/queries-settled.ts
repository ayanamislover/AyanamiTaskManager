import { useCallback, useSyncExternalStore } from "react";
import { hashKey, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";

/**
 * 这些查询是不是都已经有结果（成功或失败都算）。
 *
 * 直接看缓存，不另挂 observer：同一个 key 上可能挂着 useInfiniteQuery，再挂一个 useQuery
 * 会让两种 observer 争同一份数据的形状。还没创建的查询算「没结果」——页面的读取还没开始，
 * 不能当成已经读完。
 */
export function queriesSettled(client: QueryClient, keys: readonly QueryKey[]): boolean {
  const cache = client.getQueryCache();
  return keys.every((queryKey) => {
    const status = cache.find({ queryKey, exact: true })?.state.status;
    return status === "success" || status === "error";
  });
}

export function useQueriesSettled(keys: readonly QueryKey[]): boolean {
  const client = useQueryClient();
  // 调用方每次渲染都会新建数组；按内容（signature）缓存，快照函数不必跟着重建。
  const signature = keys.map((key) => hashKey(key)).join("|");
  const snapshot = useCallback(() => queriesSettled(client, keys), [client, signature]);
  const subscribe = useCallback(
    (onChange: () => void) => client.getQueryCache().subscribe(onChange),
    [client],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
