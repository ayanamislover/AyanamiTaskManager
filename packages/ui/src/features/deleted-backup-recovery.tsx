import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/icons/CaretDown";
import type { AyanamiClient } from "@ayanami-task/client";
import { useDialogs } from "../components/atm-dialogs.js";
import { Empty, ErrorState, LoadingRows, MutationErrorAlert } from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import { formatTime } from "../presentation.js";

/** Historical whole-store snapshots are User-only. A recovered project is imported with a fresh
 * identity; this panel never rolls back or overwrites any project in the current database. */
export function DeletedBackupRecovery({
  client,
  notify,
  onProject,
}: {
  client: AyanamiClient;
  notify: Notify;
  onProject: (code: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null);
  const dialogs = useDialogs();
  const queryClient = useQueryClient();
  const backups = useQuery({
    queryKey: ["backups", "deleted-project-recovery"],
    queryFn: () => client.backups.list(),
    enabled: expanded,
  });
  const catalog = useQuery({
    queryKey: ["backups", selectedBackup, "deleted-projects"],
    queryFn: () => client.backups.deletedProjects(selectedBackup!),
    enabled: expanded && Boolean(selectedBackup),
  });
  const restore = useMutation({
    mutationFn: ({
      backupId,
      projectId,
      code,
    }: {
      backupId: string;
      projectId: string;
      code: string;
    }) => client.backups.importDeletedProject(backupId, projectId, code),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      const code = String(result.code);
      notify(`已从历史备份导入为新项目 ${code}`);
      onProject(code);
    },
  });
  const recover = async (item: {
    id: string;
    code: string;
    name: string;
    codeTaken: boolean;
    suggestedCode: string | null;
  }) => {
    if (!selectedBackup) return;
    let code = item.code;
    if (item.codeTaken) {
      const entered = await dialogs.prompt({
        title: `导回 ${item.name}`,
        label: `原代码 ${item.code} 已被占用。请输入一个新项目代码（建议 ${item.suggestedCode ?? "另取代码"}）：`,
        placeholder: item.suggestedCode ?? "",
        maxLength: 12,
        confirmLabel: "继续",
      });
      if (!entered) return;
      code = entered;
    }
    const confirmed = await dialogs.confirm({
      title: "从旧备份导入项目",
      message: `将 ${item.name} 从历史整库备份导入为新项目 ${code}。不会覆盖当前任何项目，也不会恢复旧 Agent 会话或目录绑定。继续吗？`,
      confirmLabel: "导入新项目",
    });
    if (confirmed) restore.mutate({ backupId: selectedBackup, projectId: item.id, code });
  };
  return (
    <section
      className={`atm-panel atm-engineering atm-deleted-backup-recovery${expanded ? "" : " is-collapsed"}`}
      aria-label="历史备份恢复"
    >
      <div className="atm-panel-head">
        <button
          type="button"
          className="atm-engineering-toggle"
          aria-expanded={expanded}
          aria-controls="deleted-backup-recovery-content"
          onClick={() => setExpanded((value) => !value)}
        >
          <CaretDown size={17} aria-hidden="true" />
          <span>
            <strong>从历史备份恢复已删除项目</strong>
            <small>仅用户可操作；作为新身份导入，不覆盖现有项目</small>
          </span>
        </button>
      </div>
      <div id="deleted-backup-recovery-content" hidden={!expanded} className="atm-panel-body">
        {backups.isLoading ? <LoadingRows count={2} /> : null}
        {backups.error ? <ErrorState error={backups.error} /> : null}
        {backups.data?.length === 0 ? (
          <Empty title="没有历史备份" text="创建整库备份后可在这里找回已删除的项目。" />
        ) : null}
        <div className="atm-deleted-backup-list">
          {backups.data?.map((backup) => (
            <button
              type="button"
              className={`atm-button${selectedBackup === backup.id ? " is-selected" : ""}`}
              key={String(backup.id)}
              onClick={() => setSelectedBackup(String(backup.id))}
            >
              {String(backup.reason)} · {formatTime(String(backup.createdAt))}
            </button>
          ))}
        </div>
        {catalog.isLoading ? <LoadingRows count={2} /> : null}
        {catalog.error ? <ErrorState error={catalog.error} /> : null}
        {catalog.data && catalog.data.projects.length === 0 ? (
          <p className="atm-row-sub">这份备份里没有当前已删除的项目。</p>
        ) : null}
        {catalog.data?.projects.map((item) => (
          <div className="atm-row atm-deleted-backup-project" key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <div className="atm-row-sub">
                {item.code}
                {item.codeTaken ? ` · 原代码已占用，建议 ${item.suggestedCode}` : ""}
              </div>
            </div>
            <button
              className="atm-button"
              disabled={restore.isPending}
              onClick={() => void recover(item)}
            >
              导入为新项目
            </button>
          </div>
        ))}
        <MutationErrorAlert error={restore.error} />
      </div>
    </section>
  );
}
