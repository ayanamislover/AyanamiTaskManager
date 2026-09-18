/**
 * useCursorCollection / useCursorCollections 的浏览器夹具。
 *
 * 这两个 hook 的坑全在时序上：哪一轮读取还算数、谁能写界面、什么能进 React Query 的
 * 缓存。纯函数用例覆盖不到，仓库里也没有 jsdom，所以用真实 Chromium 跑真实 hook，
 * 配的是生产的 createAyanamiQueryClient（staleTime 3 秒、retry 1）。
 *
 * 每个来源按「第 n 次请求耗时多少毫秒」排期，好让慢的那一轮必定后于快的那一轮返回；
 * 每次请求回的条目都带着轮次号（X-R2），一眼看得出界面上停的是哪一轮的结果。
 */
import { createElement, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createAyanamiQueryClient } from "../../../../packages/ui/src/query-policy.js";
import {
  useCursorCollection,
  useCursorCollections,
} from "../../../../packages/ui/src/cursor-collection.js";

type Row = { id: string };
type Schedule = Record<string, number[]>;

const calls: Record<string, number> = {};
let schedule: Schedule = {};

function loadPage(source: string) {
  return async (_cursor?: string) => {
    const round = (calls[source] = (calls[source] ?? 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, schedule[source]?.[round - 1] ?? 10));
    return { items: [{ id: `${source}-R${round}` }] as Row[], nextCursor: null, hasMore: false };
  };
}

function publish(state: unknown) {
  (window as unknown as { __state: unknown }).__state = state;
}

function Single({ source, enabled }: { source: string; enabled: boolean }): ReactElement {
  const collection = useCursorCollection<Row>(["tasks", source], loadPage(source), enabled);
  const client = useQueryClient();
  (window as unknown as { __refetch: () => void }).__refetch = () => {
    void client.refetchQueries({ queryKey: ["tasks", source] });
  };
  publish({
    items: collection.items.map((row) => row.id),
    isLoading: collection.isLoading,
    hasMore: collection.hasMore,
    error: collection.error ? String(collection.error) : null,
    calls: { ...calls },
  });
  return createElement("span", { id: "items" }, collection.items.map((row) => row.id).join(","));
}

function Multi({ names }: { names: string[] }): ReactElement {
  const { entries } = useCursorCollections<Row>(
    ["overview"],
    names.map((name) => ({ key: name, loadPage: loadPage(name) })),
  );
  publish({
    entries: Object.fromEntries(
      Object.entries(entries).map(([name, entry]) => [
        name,
        { items: entry.items.map((row) => row.id), isLoading: entry.isLoading },
      ]),
    ),
    calls: { ...calls },
  });
  return createElement(
    "span",
    { id: "items" },
    Object.entries(entries)
      .map(([name, entry]) => `${name}:${entry.items.map((row) => row.id).join("|")}`)
      .join(","),
  );
}

function App({ multi }: { multi: boolean }): ReactElement {
  const [enabled, setEnabled] = useState(true);
  const [names, setNames] = useState(["X"]);
  (window as unknown as { __setEnabled: (next: boolean) => void }).__setEnabled = setEnabled;
  (window as unknown as { __setNames: (next: string[]) => void }).__setNames = setNames;
  return multi
    ? createElement(Multi, { names })
    : createElement(Single, { source: names[0]!, enabled });
}

(
  window as unknown as { __start: (input: { multi?: boolean; schedule: Schedule }) => void }
).__start = ({ multi = false, schedule: input }) => {
  schedule = input;
  const client = createAyanamiQueryClient();
  (window as unknown as { __cache: () => unknown }).__cache = () =>
    client
      .getQueryCache()
      .getAll()
      .map((query) => ({
        key: JSON.stringify(query.queryKey),
        status: query.state.status,
        data: query.state.data ?? null,
      }));
  const host = document.createElement("div");
  document.body.append(host);
  createRoot(host).render(
    createElement(QueryClientProvider, { client }, createElement(App, { multi })),
  );
};
