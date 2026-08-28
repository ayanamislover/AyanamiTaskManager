import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/icons/CheckCircle";
import { PlayIcon as Play } from "@phosphor-icons/react/dist/icons/Play";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import type { AyanamiClient } from "@ayanami-task/client";
import { AtmSelect } from "../components/atm-select.js";
import {
  Empty,
  ErrorState,
  LoadingRows,
  MutationErrorAlert,
  PageHead,
} from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import { Status, formatTime } from "../presentation.js";

export function QuickPage({ client, notify }: { client: AyanamiClient; notify: Notify }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [targetProject, setTargetProject] = useState("");
  const query = useQuery({ queryKey: ["quick"], queryFn: () => client.quick.list() });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => client.projects.list() });
  useEffect(() => {
    if (!targetProject)
      setTargetProject(
        projects.data?.find((project) => project.lifecycle === "ACTIVE")?.code ?? "",
      );
  }, [projects.data, targetProject]);
  const create = useMutation({
    mutationFn: () => client.quick.create({ title, note: "", actor: "USER" }),
    onSuccess: async () => {
      setTitle("");
      await queryClient.invalidateQueries({ queryKey: ["quick"] });
      await queryClient.invalidateQueries({ queryKey: ["overview"] });
      notify("已添加临时任务");
    },
  });
  const patch = useMutation({
    mutationFn: ({ id, status, version }: { id: string; status: string; version: number }) =>
      client.quick.patch(id, { status, expectedVersion: version, actor: "USER" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["quick"] }),
  });
  const promote = useMutation({
    mutationFn: (task: any) =>
      client.quick.promote(task.id, {
        expectedVersion: task.version,
        targetProjectCode: targetProject,
        actor: "USER",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      notify(`临时任务已晋升到 ${targetProject}`);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) create.mutate();
  };
  return (
    <>
      <PageHead
        title="临时任务"
        description="一次性、低复杂度工作留在全局注册库，需要持续管理时再晋升为项目。"
        actions={
          <AtmSelect
            className="wide"
            ariaLabel="晋升目标项目"
            value={targetProject}
            options={[
              { value: "", label: "选择晋升目标" },
              ...(projects.data ?? [])
                .filter((project) => project.lifecycle === "ACTIVE")
                .map((project) => ({
                  value: project.code,
                  label: `${project.code} · ${project.name}`,
                })),
            ]}
            onChange={setTargetProject}
          />
        }
      />
      <section className="atm-panel" style={{ marginBottom: 16 }}>
        <form className="atm-panel-body" onSubmit={submit} style={{ display: "flex", gap: 9 }}>
          <input
            className="atm-filter"
            style={{ flex: 1 }}
            aria-label="临时任务标题"
            placeholder="添加一件临时任务"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button className="atm-button primary" disabled={!title.trim() || create.isPending}>
            <Plus size={16} />
            添加
          </button>
        </form>
      </section>
      <section className="atm-panel">
        {query.isLoading ? (
          <LoadingRows />
        ) : query.error ? (
          <ErrorState error={query.error} />
        ) : query.data!.length === 0 ? (
          <Empty title="没有临时任务" text="适合几分钟内完成、无需拆分的工作。" />
        ) : (
          <div className="atm-list">
            {query.data!.map((task: any) => (
              <div className="atm-row" key={task.id}>
                <div>
                  <div className="atm-row-title">{task.title}</div>
                  <div className="atm-row-sub">
                    {task.key} · 更新于 {formatTime(task.updatedAt)}
                  </div>
                </div>
                <div className="atm-actions">
                  <Status value={task.status} />
                  {["OPEN", "IN_PROGRESS", "BLOCKED"].includes(task.status) ? (
                    <button
                      className="atm-button"
                      disabled={!targetProject || promote.isPending}
                      onClick={() => promote.mutate(task)}
                    >
                      晋升
                    </button>
                  ) : null}
                  {task.status === "OPEN" ? (
                    <button
                      className="atm-button atm-icon-button"
                      aria-label="开始"
                      onClick={() =>
                        patch.mutate({ id: task.id, status: "IN_PROGRESS", version: task.version })
                      }
                    >
                      <Play size={16} />
                    </button>
                  ) : null}
                  {["OPEN", "IN_PROGRESS", "BLOCKED"].includes(task.status) ? (
                    <button
                      className="atm-button atm-icon-button"
                      aria-label="完成"
                      onClick={() =>
                        patch.mutate({ id: task.id, status: "DONE", version: task.version })
                      }
                    >
                      <CheckCircle size={17} />
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <MutationErrorAlert
        errors={[create.error, patch.error, promote.error]}
        style={{ marginTop: 12 }}
      />
    </>
  );
}
