import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/icons/ArrowRight";
import type { AyanamiClient } from "@ayanami-task/client";
import { Empty, ErrorState, LoadingRows } from "../components/async-state.js";
import { useDialogAccessibility } from "../hooks/use-dialog-accessibility.js";

export function CommandPalette({
  client,
  close,
  onProject,
  onTask,
}: {
  client: AyanamiClient;
  close: () => void;
  onProject: (code: string) => void;
  onTask: (project: string, key: string) => void;
}) {
  const dialogRef = useDialogAccessibility(close);
  const [query, setQuery] = useState("");
  const result = useQuery({
    queryKey: ["search", query],
    queryFn: () => client.search(query),
    enabled: query.trim().length > 0,
  });
  const hits = ((result.data as any)?.hits ?? []) as any[];
  return (
    <div
      className="atm-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="atm-modal atm-command"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
        tabIndex={-1}
      >
        <input
          data-dialog-autofocus
          aria-label="全局搜索"
          placeholder="搜索任务、记录、阻塞和临时任务"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && result.isLoading ? (
          <LoadingRows count={3} />
        ) : query && result.error ? (
          <ErrorState error={result.error} />
        ) : query && hits.length === 0 ? (
          <Empty title="没有搜索结果" text="换一个更短或更具体的关键词。" />
        ) : (
          <div className="atm-command-results">
            {hits.map((hit, index) => (
              <button
                className="atm-row"
                key={`${hit.entity_key}:${index}`}
                onClick={() => {
                  if (hit.entity_type === "WORK_ITEM" && hit.project)
                    onTask(hit.project, hit.entity_key);
                  else if (hit.project) onProject(hit.project);
                  close();
                }}
              >
                <div>
                  <div className="atm-row-title">{hit.title}</div>
                  <div className="atm-row-sub">
                    {hit.entity_key} · {hit.project ?? "临时任务"}
                  </div>
                </div>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
