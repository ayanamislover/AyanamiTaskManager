import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/icons/CaretDown";
import type { AyanamiClient } from "@ayanami-task/client";
import { useDialogs } from "../components/atm-dialogs.js";
import { ErrorState, LoadingRows, MutationErrorAlert } from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import { backupKindLabel, formatTime } from "../presentation.js";

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
    importedAs: string | null;
  }) => {
    if (!selectedBackup) return;
    let code = item.code;
    if (item.codeTaken) {
      const entered = await dialogs.prompt({
        title: `导回 ${item.name}`,
        label: `原代码 ${item.code} 已被占用，请输入新代码`,
        placeholder: item.suggestedCode ?? "",
        maxLength: 12,
        confirmLabel: "继续",
      });
      if (!entered) return;
      code = entered;
    }
    const confirmed = await dialogs.confirm({
      title: "从旧备份导入项目",
      message: `将 ${item.name} 导入为新项目 ${code}，不覆盖现有项目。`,
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
            <small>导入为新项目，不覆盖现有项目</small>
          </span>
        </button>
      </div>
      <div id="deleted-backup-recovery-content" hidden={!expanded} className="atm-panel-body">
        {backups.isLoading ? <LoadingRows count={2} /> : null}
        {backups.error ? <ErrorState error={backups.error} /> : null}
        {backups.data?.length === 0 ? <p className="atm-row-sub">没有整库备份</p> : null}
        <div className="atm-deleted-backup-list">
          {backups.data?.map((backup) => (
            <button
              type="button"
              className={`atm-button${selectedBackup === backup.id ? " is-selected" : ""}`}
              aria-pressed={selectedBackup === backup.id}
              key={String(backup.id)}
              onClick={() => setSelectedBackup(String(backup.id))}
            >
              {backupKindLabel(String(backup.reason))} · {formatTime(String(backup.createdAt))}
            </button>
          ))}
        </div>
        {catalog.isLoading ? <LoadingRows count={2} /> : null}
        {catalog.error ? <ErrorState error={catalog.error} /> : null}
        {catalog.data && catalog.data.projects.length === 0 ? (
          <p className="atm-row-sub">这份备份里没有已删除的项目</p>
        ) : null}
        {catalog.data?.projects.map((item) => (
          <div className="atm-row atm-deleted-backup-project" key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <div className="atm-row-sub">
                {item.code}
                {item.importedAs
                  ? ` · 已导入为 ${item.importedAs}`
                  : item.codeTaken
                    ? " · 代码已占用"
                    : ""}
              </div>
            </div>
            <button
              type="button"
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
