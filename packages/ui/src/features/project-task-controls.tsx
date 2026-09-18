import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/icons/CaretDown";
import { CheckSquareIcon as CheckSquare } from "@phosphor-icons/react/dist/icons/CheckSquare";
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from "@phosphor-icons/react/dist/icons/ClockCounterClockwise";
import { KanbanIcon as Kanban } from "@phosphor-icons/react/dist/icons/Kanban";
import { ListBulletsIcon as ListBullets } from "@phosphor-icons/react/dist/icons/ListBullets";
import { RowsIcon as Rows } from "@phosphor-icons/react/dist/icons/Rows";
import { useDialogs } from "../components/atm-dialogs.js";
import { AtmSelect } from "../components/atm-select.js";
import { MutationErrorAlert } from "../components/async-state.js";
import { moveRovingFocus } from "../components/keyboard-interactions.js";
import type { Notify } from "../contracts.js";
import { progressSourceLabels, statusLabels } from "../presentation.js";
import {
  DEFAULT_PROJECT_TASK_SORT,
  sortProjectTasks,
  toggleProjectTaskSort,
  type ProjectTaskSort,
  type ProjectTaskSortField,
} from "../task-sort.js";

export type ProjectTaskView = "list" | "board" | "timeline" | "tree" | "records";

const PROJECT_TASK_VIEWS = [
  { value: "list", label: "列表", Icon: ListBullets },
  { value: "board", label: "看板", Icon: Kanban },
  { value: "timeline", label: "时间线", Icon: ClockCounterClockwise },
  { value: "tree", label: "层级", Icon: Rows },
  { value: "records", label: "记录", Icon: CheckSquare },
] as const;

export type ProjectTaskFilters = {
  status: string;
  assignee: string;
  milestone: string;
  due: "" | "OVERDUE" | "DATED";
  blockedOnly: boolean;
  progressSource: string;
};

export const EMPTY_PROJECT_TASK_FILTERS: ProjectTaskFilters = {
  status: "",
  assignee: "",
  milestone: "",
  due: "",
  blockedOnly: false,
  progressSource: "",
};

export function filterProjectTasks(tasks: any[], filters: ProjectTaskFilters): any[] {
  return tasks.filter((task: any) => {
    if (filters.status && task.status !== filters.status) return false;
    if (filters.assignee && task.assigneeAgentId !== filters.assignee) return false;
    if (filters.milestone && task.milestoneId !== filters.milestone) return false;
    if (filters.blockedOnly && !task.blockedReason && task.status !== "BLOCKED") return false;
    if (filters.progressSource && task.progressSource !== filters.progressSource) return false;
    if (filters.due === "DATED" && !task.targetDate) return false;
    if (
      filters.due === "OVERDUE" &&
      (!task.targetDate ||
        task.targetDate >= new Date().toISOString().slice(0, 10) ||
        ["DONE", "CANCELLED"].includes(task.status))
    )
      return false;
    return true;
  });
}

/**
 * 未结束任务按表头排序；已结束任务单独成组，保持「最近结束在前」的顺序，不参与表头排序，
 * 否则按状态或优先级一排，几百个已完成任务会和进行中的任务交错在一起。
 */
/**
 * 层级视图要显示的行，按父子顺序排开。
 *
 * 列表默认只取未结束任务加最近结束的几项，所以父任务可能不在当前数据里。
 * 「从 parentId === null 往下递归」会让这些子任务整个消失——数据还在，界面上没有。
 * 找不到父节点的一律当根节点显示；成环时靠 visited 兜底，不无限递归。
 */
export function taskTreeRows(tasks: any[]): Array<{ task: any; depth: number }> {
  const byParent = new Map<string | null, any[]>();
  const ids = new Set(tasks.map((task: any) => task.id));
  for (const task of tasks) {
    const parentId = task.parentId ?? null;
    const anchor = parentId !== null && ids.has(parentId) ? parentId : null;
    const siblings = byParent.get(anchor);
    if (siblings) siblings.push(task);
    else byParent.set(anchor, [task]);
  }
  const rows: Array<{ task: any; depth: number }> = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null, depth: number): void => {
    // 每个任务只挂在一个父节点下，递归不会重复到达；成环的那些从 null 根本走不到，
    // 由下面的兜底补齐，所以这里不需要再判一次 visited。
    for (const task of byParent.get(parentId) ?? []) {
      visited.add(task.id);
      rows.push({ task, depth });
      walk(task.id, depth + 1);
    }
  };
  walk(null, 0);
  // 只在环里的任务谁都到不了，补在末尾，仍然不丢。
  for (const task of tasks) {
    if (visited.has(task.id)) continue;
    visited.add(task.id);
    rows.push({ task, depth: 0 });
  }
  return rows;
}

export function projectTaskGroups(
  openTasks: any[],
  closedTasks: any[],
  filters: ProjectTaskFilters,
  taskSort: ProjectTaskSort,
) {
  // 两次读取之间刚结束的任务可能同时出现在两边，以已结束那边为准。
  const closedKeys = new Set(closedTasks.map((task: any) => task.key));
  const allTasks = [...openTasks.filter((task: any) => !closedKeys.has(task.key)), ...closedTasks];
  const filteredTasks = filterProjectTasks(allTasks, filters);
  return {
    allTasks,
    filteredTasks,
    sortedTasks: sortProjectTasks(
      filteredTasks.filter((task: any) => !closedKeys.has(task.key)),
      taskSort,
    ),
    closedRows: filteredTasks.filter((task: any) => closedKeys.has(task.key)),
  };
}

export function useProjectTaskViewState(openTasks: any[], closedTasks: any[] = []) {
  const [view, setView] = useState<ProjectTaskView>("list");
  const [filters, setFilters] = useState<ProjectTaskFilters>(EMPTY_PROJECT_TASK_FILTERS);
  const [taskSort, setTaskSort] = useState<ProjectTaskSort>(DEFAULT_PROJECT_TASK_SORT);
  const groups = projectTaskGroups(openTasks, closedTasks, filters, taskSort);
  return {
    view,
    setView,
    filters,
    setFilters,
    taskSort,
    ...groups,
    /**
     * 已结束任务必须全部取回的两种情况：用户明确要看已完成/已取消，
     * 以及层级视图——父任务缺一个，它下面整棵子树就没了。
     */
    wantsAllClosed: filters.status === "DONE" || filters.status === "CANCELLED" || view === "tree",
    onTaskSort: (field: ProjectTaskSortField) =>
      setTaskSort((current) => toggleProjectTaskSort(current, field)),
  };
}

function ProjectTaskFilterBar({
  client,
  project,
  tasks,
  value,
  onChange,
  notify,
}: {
  client: AyanamiClient;
  project: string;
  tasks: any[];
  value: ProjectTaskFilters;
  onChange: (value: ProjectTaskFilters) => void;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const dialogs = useDialogs();
  const [selected, setSelected] = useState("");
  const views = useQuery({
    queryKey: ["saved-views", project],
    queryFn: () => client.savedViews.list(project),
  });
  const milestones = useQuery({
    queryKey: ["milestones", project],
    queryFn: () => client.projects.milestones(project),
  });
  const create = useMutation({
    mutationFn: (name: string) =>
      client.savedViews.create({
        scope: "PROJECT",
        project,
        name,
        query: value,
        sort: { field: "priority", direction: "desc" },
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["saved-views", project] });
      setSelected(String(created.id));
      notify("已保存当前视图");
    },
  });
  const remove = useMutation({
    mutationFn: (view: any) => client.savedViews.remove(String(view.id), Number(view.version)),
    onSuccess: async () => {
      setSelected("");
      await queryClient.invalidateQueries({ queryKey: ["saved-views", project] });
      notify("已删除保存视图");
    },
  });
  const chosen = views.data?.find((view) => view.id === selected);
  const patch = (next: Partial<ProjectTaskFilters>) => onChange({ ...value, ...next });
  const assignees = [
    ...new Set(
      tasks.map((task) => task.assigneeAgentId).filter((entry): entry is string => Boolean(entry)),
    ),
  ];
  return (
    <div className="atm-filterbar">
      <AtmSelect
        ariaLabel="保存视图"
        value={selected}
        options={[
          { value: "", label: "保存视图" },
          ...(views.data ?? []).map((view) => ({ value: String(view.id), label: view.name })),
        ]}
        onChange={(id) => {
          setSelected(id);
          const view = views.data?.find((candidate) => candidate.id === id);
          if (view)
            onChange({
              ...EMPTY_PROJECT_TASK_FILTERS,
              ...(view.query as Partial<ProjectTaskFilters>),
            });
        }}
      />
      <AtmSelect
        ariaLabel="状态筛选"
        value={value.status}
        options={[
          { value: "", label: "全部状态" },
          ...Object.entries(statusLabels)
            .filter(([key]) =>
              [
                "BACKLOG",
                "READY",
                "CLAIMED",
                "IN_PROGRESS",
                "BLOCKED",
                "WAITING_USER",
                "WAITING_AGENT",
                "VERIFYING",
                "DONE",
                "CANCELLED",
              ].includes(key),
            )
            .map(([key, label]) => ({ value: key, label })),
        ]}
        onChange={(status) => patch({ status })}
      />
      <AtmSelect
        ariaLabel="Agent 筛选"
        className="wide"
        value={value.assignee}
        options={[
          { value: "", label: "全部负责人" },
          ...assignees.map((agent) => ({
            value: agent,
            label: agent === "USER" ? "桌面用户" : agent,
          })),
        ]}
        onChange={(assignee) => patch({ assignee })}
      />
      <AtmSelect
        ariaLabel="里程碑筛选"
        className="medium"
        value={value.milestone}
        options={[
          { value: "", label: "全部里程碑" },
          ...(milestones.data ?? []).map((milestone) => ({
            value: String(milestone.id),
            label: milestone.title,
          })),
        ]}
        onChange={(milestone) => patch({ milestone })}
      />
      <AtmSelect
        ariaLabel="截止日期筛选"
        value={value.due}
        options={[
          { value: "", label: "全部日期" },
          { value: "OVERDUE", label: "已超期" },
          { value: "DATED", label: "已设目标日" },
        ]}
        onChange={(due) => patch({ due: due as ProjectTaskFilters["due"] })}
      />
      <AtmSelect
        ariaLabel="进度来源筛选"
        className="medium"
        value={value.progressSource}
        options={[
          { value: "", label: "全部进度来源" },
          ...Object.entries(progressSourceLabels).map(([key, label]) => ({ value: key, label })),
        ]}
        onChange={(progressSource) => patch({ progressSource })}
      />
      <label className="atm-filter atm-filter-check">
        <input
          type="checkbox"
          checked={value.blockedOnly}
          onChange={(event) => patch({ blockedOnly: event.target.checked })}
        />
        仅阻塞
      </label>
      <button
        className="atm-button"
        onClick={async () => {
          const name = await dialogs.prompt({
            title: "保存当前视图",
            label: "视图名称",
            placeholder: "例如：本周阻塞",
            confirmLabel: "保存",
            maxLength: 80,
          });
          if (name !== null) create.mutate(name);
        }}
      >
        保存当前
      </button>
      {chosen ? (
        <button
          className="atm-button danger"
          disabled={remove.isPending}
          onClick={() => remove.mutate(chosen)}
        >
          删除视图
        </button>
      ) : null}
      {Object.values(value).some(Boolean) ? (
        <button
          className="atm-button"
          onClick={() => {
            setSelected("");
            onChange(EMPTY_PROJECT_TASK_FILTERS);
          }}
        >
          清除筛选
        </button>
      ) : null}
      <MutationErrorAlert errors={[create.error, remove.error]} />
    </div>
  );
}

export function ProjectTaskControls({
  client,
  project,
  tasks,
  view,
  onViewChange,
  filters,
  onFiltersChange,
  notify,
}: {
  client: AyanamiClient;
  project: string;
  tasks: any[];
  view: ProjectTaskView;
  onViewChange: (view: ProjectTaskView) => void;
  filters: ProjectTaskFilters;
  onFiltersChange: (filters: ProjectTaskFilters) => void;
  notify: Notify;
}) {
  return (
    <>
      <div className="atm-toolbar">
        <div className="atm-tabs" role="tablist" aria-label="项目任务视图">
          {PROJECT_TASK_VIEWS.map(({ value, label, Icon }, index) => (
            <button
              key={value}
              id={`project-task-tab-${value}`}
              role="tab"
              aria-selected={view === value}
              aria-controls="project-task-panel"
              tabIndex={view === value ? 0 : -1}
              onClick={() => onViewChange(value)}
              onKeyDown={(event) =>
                moveRovingFocus(event, {
                  selector: '[role="tab"]',
                  index,
                  count: PROJECT_TASK_VIEWS.length,
                  onMove: (next) => onViewChange(PROJECT_TASK_VIEWS[next]!.value),
                })
              }
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>
      </div>
      {!new Set(["timeline", "records"]).has(view) ? (
        <ProjectTaskFilterBar
          client={client}
          project={project}
          tasks={tasks}
          value={filters}
          onChange={onFiltersChange}
          notify={notify}
        />
      ) : null}
    </>
  );
}

export function ProjectTaskSortHeader({
  field,
  label,
  sort,
  onSort,
}: {
  field: ProjectTaskSortField;
  label: string;
  sort: ProjectTaskSort | null;
  onSort: (field: ProjectTaskSortField) => void;
}) {
  const active = sort?.field === field;
  return (
    <th aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}>
      <button
        className="atm-table-sort"
        data-active={active ? "true" : "false"}
        data-direction={active ? sort.direction : undefined}
        aria-label={`按${label}排序`}
        title={
          active ? `当前${sort.direction === "asc" ? "正序" : "倒序"}，点击切换` : "点击倒序排列"
        }
        onClick={() => onSort(field)}
      >
        <span>{label}</span>
        <CaretDown size={13} weight="bold" aria-hidden="true" />
      </button>
    </th>
  );
}
