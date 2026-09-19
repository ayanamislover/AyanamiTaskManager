import { useState, type DragEvent, type KeyboardEvent } from "react";

/**
 * 项目手动顺序的纯逻辑与拖放交互。
 *
 * 读写设置那一半在 ../project-order.ts：它要用 client 和 react-query，而 shell 层不许碰
 * 这两样。顺序对象由 app.tsx 取好，再作为 prop 传给侧栏。
 */
export type ProjectOrder = {
  order: string[];
  apply: <T extends { id: string }>(projects: T[]) => T[];
  /** 把 id 放到 beforeId 之前（null 表示末尾），visible 是当前这一屏的完整顺序。 */
  drop: (visible: string[], id: string, beforeId: string | null) => void;
  /** 键盘上下挪一格。 */
  nudge: (visible: string[], id: string, delta: number) => void;
};

/**
 * 按手动顺序排列；没排过的排在后面，彼此保持原有顺序。
 *
 * 新建的项目不在顺序表里，不能因此被丢掉，也不该插到用户排好的队伍中间。
 */
export function orderProjects<T extends { id: string }>(projects: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...projects].sort((left, right) => {
    const leftRank = rank.get(left.id);
    const rightRank = rank.get(right.id);
    if (leftRank === undefined && rightRank === undefined) return 0;
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    return leftRank - rightRank;
  });
}

/**
 * 把这一屏重排后的顺序合回完整的顺序表。
 *
 * 侧栏只列 ACTIVE 项目，重排后却把这一屏整份存成 projects.order，归档项目的手动位置就此
 * 消失：全局顺序 `[c(归档), b, a]`，在侧栏把 a 往上挪一格，存下去变成 `[a, b]`，c 掉到末尾。
 * 用户只想调换两个项目，被动的却是没在这一屏出现过的第三个。
 *
 * 合并规则：完整表里属于这一屏的槽位按新顺序依次填回，不在这一屏的条目留在原位；
 * 这一屏里完整表还没有的（新建项目）补在末尾。
 *
 * 不在这一屏的 id 一律保留，包括已经删掉的项目——这里分不出「被筛掉」和「已经没了」，
 * 而认错的代价不对称：留着一个陈旧 id 只是多几十字节，orderProjects 本来就忽略认不出的 id；
 * 删错一个归档项目的位置，用户得手动排回去。
 */
export function mergeProjectOrder(stored: string[], nextVisible: string[]): string[] {
  const visible = new Set(nextVisible);
  const queue = [...nextVisible];
  const merged: string[] = [];
  for (const id of stored) {
    if (!visible.has(id)) {
      merged.push(id);
      continue;
    }
    const next = queue.shift();
    if (next !== undefined) merged.push(next);
  }
  return [...merged, ...queue];
}

/**
 * 把 `id` 挪到 `beforeId` 前面；`beforeId` 为 null 表示挪到末尾。
 *
 * 入参是当前这一屏的完整顺序（含没排过的）；这一屏可能只是全部项目的一个子集，
 * 存盘前要先经 mergeProjectOrder 合回完整表。
 */
export function reorderProjectIds(
  visible: string[],
  id: string,
  beforeId: string | null,
): string[] {
  if (id === beforeId) return [...visible];
  const rest = visible.filter((each) => each !== id);
  if (beforeId === null) return [...rest, id];
  const at = rest.indexOf(beforeId);
  if (at < 0) return [...visible];
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** 键盘版：把 `id` 上下挪一格。到头了就保持不动。 */
export function moveProjectId(visible: string[], id: string, delta: number): string[] {
  const from = visible.indexOf(id);
  if (from < 0) return [...visible];
  const to = from + delta;
  if (to < 0 || to >= visible.length) return [...visible];
  const rest = visible.filter((each) => each !== id);
  return [...rest.slice(0, to), id, ...rest.slice(to)];
}

/**
 * 拖放落定后要存的完整顺序表。
 *
 * 与下面的键盘版一起从 hook 里提出来，是因为错的就是这一步：原来 hook 直接把这一屏
 * 的顺序存了下去。留在 hook 里就只能靠 e2e 抓，而仓里没有 React 单元测试设施。
 */
export function projectOrderAfterDrop(
  stored: string[],
  visible: string[],
  id: string,
  beforeId: string | null,
): string[] {
  return mergeProjectOrder(stored, reorderProjectIds(visible, id, beforeId));
}

/** 键盘挪一格后要存的完整顺序表。 */
export function projectOrderAfterNudge(
  stored: string[],
  visible: string[],
  id: string,
  delta: number,
): string[] {
  return mergeProjectOrder(stored, moveProjectId(visible, id, delta));
}

/** 落点：放在 `id` 前面还是后面。按指针落在目标的哪一半算，不然排到最末尾就没法表达。 */
type DropTarget = { id: string; after: boolean };

function beforeIdFor(visible: string[], target: DropTarget): string | null {
  if (!target.after) return target.id;
  const next = visible[visible.indexOf(target.id) + 1];
  return next ?? null;
}

/**
 * 拖动排序的交互。侧栏是竖着一列，项目卡是网格，落点按 axis 决定量哪一边。
 *
 * 键盘也能排：焦点落在某一项上按 Alt+↑/↓ 挪一格。只能拖的排序对键盘用户等于没有。
 */
export function useProjectReorder(
  visible: string[],
  order: ProjectOrder,
  axis: "vertical" | "horizontal" = "vertical",
) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const clear = () => {
    setDragging(null);
    setOver(null);
  };
  return (id: string) => ({
    draggable: true,
    "data-dragging": dragging === id ? "true" : undefined,
    "data-drop":
      over && over.id === id && dragging !== id ? (over.after ? "after" : "before") : undefined,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      setDragging(id);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    },
    onDragEnd: clear,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!dragging) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const rect = event.currentTarget.getBoundingClientRect();
      const after =
        axis === "vertical"
          ? event.clientY > rect.top + rect.height / 2
          : event.clientX > rect.left + rect.width / 2;
      setOver((current) =>
        current && current.id === id && current.after === after ? current : { id, after },
      );
    },
    onDragLeave: () => setOver((current) => (current && current.id === id ? null : current)),
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const moved = dragging ?? event.dataTransfer.getData("text/plain");
      const target = over ?? { id, after: false };
      clear();
      if (!moved || moved === id) return;
      order.drop(visible, moved, beforeIdFor(visible, target));
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!event.altKey) return;
      const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      order.nudge(visible, id, delta);
    },
  });
}
