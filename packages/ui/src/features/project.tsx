import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon as Archive } from "@phosphor-icons/react/dist/icons/Archive";
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "@phosphor-icons/react/dist/icons/ArrowCounterClockwise";
import { PlayIcon as Play } from "@phosphor-icons/react/dist/icons/Play";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import type { AyanamiClient, RegisteredProject } from "@ayanami-task/client";
import { MutationErrorAlert, PageHead } from "../components/async-state.js";
import type { DesktopBridge, Notify } from "../contracts.js";
import { useCursorCollection } from "../cursor-collection.js";
import { CreateRecordModal } from "./create-record-modal.js";
import { CreateTaskModal } from "./create-task-modal.js";
import { ProjectDataModal } from "./project-data-modal.js";
import { ProjectSummary } from "./project-summary.js";
import { ProjectTaskControls, useProjectTaskViewState } from "./project-task-controls.js";
import { ProjectTaskViews } from "./project-task-views.js";
import { ProjectUpdateModal } from "./project-update-modal.js";

export function ProjectPage({
  client,
  project,
  notify,
  openTask,
  onExit,
  desktop,
}: {
  client: AyanamiClient;
  project: RegisteredProject;
  notify: Notify;
  openTask: (key: string) => void;
  onExit: () => void;
  desktop?: DesktopBridge;
}) {
  const queryClient = useQueryClient();
  const [create, setCreate] = useState(false);
  const [createRecord, setCreateRecord] = useState(false);
  const [dataTools, setDataTools] = useState(false);
  const [updateProject, setUpdateProject] = useState(false);
  const tasks = useCursorCollection(["tasks", project.code, "ui"], (cursor) =>
    client.tasks.pageForUi(project.code, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  const { view, setView, filters, setFilters, taskSort, filteredTasks, sortedTasks, onTaskSort } =
    useProjectTaskViewState(tasks.items);
  const events = useQuery({
    queryKey: ["events", project.code],
    queryFn: () => client.events(project.code, 0, 100),
    enabled: view === "timeline",
  });
  const records = useCursorCollection(
    ["records", project.code],
    (cursor) => client.projects.recordPage(project.code, 100, cursor),
    view === "records",
  );
  const lifecycle = useMutation({
    mutationFn: () =>
      project.lifecycle === "ARCHIVED"
        ? client.projects.restore(project.code)
        : client.projects.archive(project.code),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["overview"] });
      notify(project.lifecycle === "ARCHIVED" ? "项目已恢复" : "项目已归档");
    },
  });
  const trash = useMutation({
    mutationFn: () => client.projects.trash(project.code),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      notify("项目已移入垃圾箱，可在项目页恢复");
      onExit();
    },
  });
  useEffect(() => {
    const listener = () => setCreate(true);
    window.addEventListener("atm:new-project-task", listener);
    return () => window.removeEventListener("atm:new-project-task", listener);
  }, []);
  const workItems = tasks.items as any[];
  return (
    <>
      <PageHead
        title={project.name}
        description={project.description || `${project.code} 的正式项目工作区。`}
        actions={
          <>
            <button className="atm-button" onClick={() => setUpdateProject(true)}>
              发布项目更新
            </button>
            <button className="atm-button" onClick={() => setDataTools(true)}>
              数据工具
            </button>
            <button
              className="atm-button"
              onClick={async () => {
                const configs = await desktop?.getMcpConfigs?.();
                if (configs && desktop?.copyText) {
                  await desktop.copyText(`${configs.agentRule}\n项目代码：${project.code}`);
                  notify("Agent 开工规则与项目代码已复制");
                } else notify("请让 Agent 调用 atm_begin，并传入当前项目代码");
              }}
            >
              <Play size={16} />
              启动 Agent 会话
            </button>
            <button
              className={`atm-button ${project.lifecycle === "ARCHIVED" ? "" : "danger"}`}
              onClick={() => lifecycle.mutate()}
              disabled={lifecycle.isPending}
            >
              {project.lifecycle === "ARCHIVED" ? (
                <ArrowCounterClockwise size={16} />
              ) : (
                <Archive size={16} />
              )}
              {project.lifecycle === "ARCHIVED" ? "恢复项目" : "归档项目"}
            </button>
            {project.lifecycle === "ARCHIVED" ? (
              <button
                className="atm-button danger"
                disabled={trash.isPending}
                onClick={() => {
                  if (window.confirm("移入垃圾箱前会创建备份，之后可从项目页恢复。继续吗？"))
                    trash.mutate();
                }}
              >
                移入垃圾箱
              </button>
            ) : null}
            {view === "records" ? (
              <button
                className="atm-button primary"
                onClick={() => setCreateRecord(true)}
                disabled={project.lifecycle !== "ACTIVE"}
              >
                <Plus size={16} />
                新建记录
              </button>
            ) : (
              <button
                className="atm-button primary"
                onClick={() => setCreate(true)}
                disabled={project.lifecycle !== "ACTIVE"}
              >
                <Plus size={16} />
                新建任务
              </button>
            )}
          </>
        }
      />
      <ProjectSummary
        client={client}
        projectCode={project.code}
        workItems={workItems}
        notify={notify}
        openTask={openTask}
      />
      <ProjectTaskControls
        client={client}
        project={project.code}
        tasks={tasks.items}
        view={view}
        onViewChange={setView}
        filters={filters}
        onFiltersChange={setFilters}
        notify={notify}
      />
      <ProjectTaskViews
        view={view}
        tasks={tasks}
        records={records}
        events={events}
        filteredTasks={filteredTasks}
        sortedTasks={sortedTasks}
        taskSort={taskSort}
        onTaskSort={onTaskSort}
        onOpenTask={openTask}
      />
      <MutationErrorAlert errors={[lifecycle.error, trash.error]} />
      {create ? (
        <CreateTaskModal
          client={client}
          project={project.code}
          close={() => setCreate(false)}
          notify={notify}
        />
      ) : null}
      {createRecord ? (
        <CreateRecordModal
          client={client}
          project={project.code}
          close={() => setCreateRecord(false)}
          notify={notify}
        />
      ) : null}
      {updateProject ? (
        <ProjectUpdateModal
          client={client}
          project={project.code}
          close={() => setUpdateProject(false)}
          notify={notify}
        />
      ) : null}
      {dataTools ? (
        <ProjectDataModal
          client={client}
          project={project.code}
          close={() => setDataTools(false)}
          notify={notify}
        />
      ) : null}
    </>
  );
}
