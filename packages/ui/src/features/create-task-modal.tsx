import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import type { AyanamiClient } from "@ayanami-task/client";
import { AtmSelect } from "../components/atm-select.js";
import { MutationErrorAlert } from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import { useDialogAccessibility } from "../hooks/use-dialog-accessibility.js";

export function CreateTaskModal({
  client,
  project,
  close,
  notify,
}: {
  client: AyanamiClient;
  project: string;
  close: () => void;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useDialogAccessibility(close);
  const context = useQuery({
    queryKey: ["objectives", project],
    queryFn: () => client.projects.objectives(project),
  });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("NORMAL");
  const [acceptance, setAcceptance] = useState("");
  const mutation = useMutation({
    mutationFn: async () => {
      const objective = context.data?.find((item) => item.status === "ACTIVE") ?? context.data?.[0];
      if (!objective) throw new Error("请先为项目创建活动目标");
      return client.tasks.createAsUser(project, {
        opId: `ui-create-${crypto.randomUUID()}`,
        items: [
          {
            clientRef: "ui-task",
            objectiveId: objective.id,
            title,
            description,
            type: "TASK",
            priority,
            status: "READY",
            acceptance: acceptance
              .split(/\r?\n/u)
              .map((item) => item.trim())
              .filter(Boolean),
            checklist: [],
            dependsOn: [],
            dependsOnRefs: [],
            weight: 1,
            verificationRequired: false,
          },
        ],
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tasks", project] }),
        queryClient.invalidateQueries({ queryKey: ["reconciliation", project] }),
        queryClient.invalidateQueries({ queryKey: ["brief", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      notify("任务已创建");
      close();
    },
  });
  return (
    <div className="atm-modal-backdrop">
      <section
        ref={dialogRef}
        className="atm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-task-title"
        tabIndex={-1}
      >
        <header className="atm-modal-head">
          <h2 id="create-task-title">新建任务</h2>
          <button className="atm-button atm-icon-button" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="atm-modal-body">
          <div className="atm-form">
            <div className="atm-field">
              <label htmlFor="task-title">标题</label>
              <input
                id="task-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                data-dialog-autofocus
              />
            </div>
            <div className="atm-field">
              <label htmlFor="task-description">说明</label>
              <textarea
                id="task-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="atm-field">
              <label htmlFor="task-priority">优先级</label>
              <AtmSelect
                id="task-priority"
                ariaLabel="优先级"
                value={priority}
                options={[
                  { value: "LOW", label: "低" },
                  { value: "NORMAL", label: "普通" },
                  { value: "HIGH", label: "高" },
                  { value: "CRITICAL", label: "紧急" },
                ]}
                onChange={setPriority}
              />
            </div>
            <div className="atm-field">
              <label htmlFor="task-acceptance">验收标准</label>
              <textarea
                id="task-acceptance"
                value={acceptance}
                onChange={(e) => setAcceptance(e.target.value)}
                placeholder="每行一条"
              />
            </div>
            <MutationErrorAlert error={mutation.error} />
          </div>
        </div>
        <footer className="atm-modal-foot">
          <button className="atm-button" onClick={close}>
            取消
          </button>
          <button
            className="atm-button primary"
            disabled={!title.trim() || mutation.isPending || context.isLoading}
            onClick={() => mutation.mutate()}
          >
            创建任务
          </button>
        </footer>
      </section>
    </div>
  );
}
