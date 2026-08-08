import { QueryClient } from "@tanstack/react-query";

export const ATM_QUERY_REFRESH_INTERVAL_MS = 30_000;

export function createAyanamiQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 3000,
        refetchInterval: ATM_QUERY_REFRESH_INTERVAL_MS,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
