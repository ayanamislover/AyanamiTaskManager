import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import {
  orderProjects,
  projectOrderAfterDrop,
  projectOrderAfterNudge,
  type ProjectOrder,
} from "./hooks/use-project-reorder.js";

export {
  mergeProjectOrder,
  moveProjectId,
  orderProjects,
  projectOrderAfterDrop,
  projectOrderAfterNudge,
  reorderProjectIds,
  useProjectReorder,
  type ProjectOrder,
} from "./hooks/use-project-reorder.js";

/**
 * 项目手动顺序的存取。
 *
 * 默认排序是 `projects.updated_at DESC`：项目一被动过就往前窜，昨天排第一的今天掉到第五，
 * 侧栏里找项目变成每次都要重新看一遍。手动排过的顺序存在 registry 设置里，
 * 侧栏和项目卡片读同一份，两处永远一致。
 */
export const PROJECT_ORDER_SETTING = "projects.order";

/** 设置值可能是任何形状（手改过、旧版本写的），认不出来就当没排过。 */
export function projectOrderFromSetting(value: unknown): string[] {
  const ids = (value as { ids?: unknown } | null | undefined)?.ids;
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  return kept;
}

export function useProjectOrder(client: AyanamiClient): ProjectOrder {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["settings", PROJECT_ORDER_SETTING],
    queryFn: async () => {
      const rows = await client.settings.list();
      return projectOrderFromSetting(rows.find((row) => row.key === PROJECT_ORDER_SETTING)?.value);
    },
  });
  const order = query.data ?? [];
  const save = useMutation({
    mutationFn: (ids: string[]) => client.settings.put(PROJECT_ORDER_SETTING, { ids }),
    // 先把新顺序摆上去再落盘：拖完等一个来回才动，手感像卡住了。
    onMutate: (ids: string[]) => {
      queryClient.setQueryData(["settings", PROJECT_ORDER_SETTING], ids);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["settings", PROJECT_ORDER_SETTING] }),
  });
  const apply = useCallback(
    <T extends { id: string }>(projects: T[]) => orderProjects(projects, order),
    [order],
  );
  // visible 可能只是全部项目的一个子集（侧栏只列 ACTIVE），存盘前先合回完整表，
  // 否则没在这一屏出现的项目会被这次重排顺手抹掉。
  const drop = useCallback(
    (visible: string[], id: string, beforeId: string | null) => {
      save.mutate(projectOrderAfterDrop(order, visible, id, beforeId));
    },
    [order, save],
  );
  const nudge = useCallback(
    (visible: string[], id: string, delta: number) => {
      save.mutate(projectOrderAfterNudge(order, visible, id, delta));
    },
    [order, save],
  );
  return { order, apply, drop, nudge };
}
