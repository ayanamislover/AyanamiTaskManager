import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import type { AyanamiClient } from "@ayanami-task/client";
import { Empty, LoadingRows, MutationErrorAlert } from "../components/async-state.js";
import type { PresenceRootProps } from "../components/presence.js";
import type { Notify } from "../contracts.js";
import { useDialogAccessibility } from "../hooks/use-dialog-accessibility.js";
import { formatTime } from "../presentation.js";

export function ProjectDataModal({
  client,
  project,
  close,
  notify,
  ...presenceRootProps
}: {
  client: AyanamiClient;
  project: string;
  close: () => void;
  notify: Notify;
} & PresenceRootProps) {
  const queryClient = useQueryClient();
  const dialogRef = useDialogAccessibility(close, presenceRootProps["data-presence"] !== "closing");
  const backups = useQuery({
    queryKey: ["backups", project],
    queryFn: () => client.backups.list(project),
  });
  const [source, setSource] = useState<{ name: string; content: string } | null>(null);
  const [preview, setPreview] = useState<Record<string, any> | null>(null);
  const createBackup = useMutation({
    mutationFn: () => client.backups.create(project),
    onSuccess: async () => {
      await backups.refetch();
      notify("项目备份已创建并校验");
    },
  });
  const restore = useMutation({
    mutationFn: (id: string) => client.backups.restore(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      notify("项目已从备份恢复");
    },
  });
  const exportData = useMutation({
    mutationFn: (format: "aytproj" | "json" | "csv") => client.data.exportProject(project, format),
    onSuccess: (result) => notify(`导出完成：${String(result.path)}`),
  });
  const previewImport = useMutation({
    mutationFn: async () => {
      if (!source) throw new Error("请先选择 agenttask.md");
      return client.data.previewAgentTask({
        project,
        content: source.content,
        sourceName: source.name,
      });
    },
    onSuccess: setPreview,
  });
  const applyImport = useMutation({
    mutationFn: async () => {
      if (!source || !preview) throw new Error("请先生成导入预览");
      return client.data.applyAgentTask({
        project,
        content: source.content,
        sourceName: source.name,
        expectedSha256: preview.sha256,
      });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      notify(result.alreadyImported ? "该文件已经导入过" : "旧任务账本已导入");
    },
  });
  return (
    <div {...presenceRootProps} className="atm-modal-backdrop">
      <section
        ref={dialogRef}
        className="atm-modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-tools-title"
        tabIndex={-1}
      >
        <header className="atm-modal-head">
          <h2 id="data-tools-title">备份、恢复与数据交换</h2>
          <button className="atm-button atm-icon-button" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="atm-modal-body atm-form">
          <section className="atm-section">
            <div className="atm-actions" style={{ justifyContent: "space-between" }}>
              <div>
                <h3>项目备份</h3>
                <div className="atm-row-sub">
                  使用 SQLite Online Backup 创建一致性快照，并校验 SHA-256。
                </div>
              </div>
              <button
                className="atm-button primary"
                disabled={createBackup.isPending}
                onClick={() => createBackup.mutate()}
              >
                立即备份
              </button>
            </div>
            <div className="atm-panel" style={{ marginTop: 12 }}>
              {backups.isLoading ? (
                <LoadingRows count={2} />
              ) : backups.data?.length ? (
                <div className="atm-list">
                  {backups.data.slice(0, 8).map((backup) => (
                    <div className="atm-row" key={backup.id}>
                      <div>
                        <div className="atm-row-title">
                          {backup.reason} · {(Number(backup.sizeBytes) / 1024).toFixed(1)} KB
                        </div>
                        <div className="atm-row-sub">
                          {formatTime(backup.createdAt)} · {backup.verifiedAt ? "已验证" : "未验证"}
                        </div>
                      </div>
                      <button
                        className="atm-button danger"
                        disabled={restore.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              "恢复会先备份当前项目，然后以所选快照替换项目数据。继续吗？",
                            )
                          )
                            restore.mutate(String(backup.id));
                        }}
                      >
                        恢复
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title="没有项目备份" text="创建首个手动备份后会显示在这里。" />
              )}
            </div>
          </section>
          <section className="atm-section">
            <h3>导出项目</h3>
            <div className="atm-row-sub" style={{ marginBottom: 10 }}>
              .aytproj 含数据库一致性快照和校验清单；JSON/CSV 用于只读检查。
            </div>
            <div className="atm-actions">
              <button
                className="atm-button"
                disabled={exportData.isPending}
                onClick={() => exportData.mutate("aytproj")}
              >
                导出 .aytproj
              </button>
              <button
                className="atm-button"
                disabled={exportData.isPending}
                onClick={() => exportData.mutate("json")}
              >
                导出 JSON
              </button>
              <button
                className="atm-button"
                disabled={exportData.isPending}
                onClick={() => exportData.mutate("csv")}
              >
                导出 CSV
              </button>
            </div>
          </section>
          <section className="atm-section">
            <h3>导入旧 agenttask.md</h3>
            <div className="atm-field">
              <label htmlFor="agenttask-file">选择 Markdown 文件</label>
              <input
                id="agenttask-file"
                type="file"
                accept=".md,text/markdown,text/plain"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  setPreview(null);
                  setSource(file ? { name: file.name, content: await file.text() } : null);
                }}
              />
            </div>
            <div className="atm-actions" style={{ marginTop: 10 }}>
              <button
                className="atm-button"
                disabled={!source || previewImport.isPending}
                onClick={() => previewImport.mutate()}
              >
                生成预览
              </button>
              {preview ? (
                <button
                  className="atm-button primary"
                  disabled={preview.alreadyImported || applyImport.isPending}
                  onClick={() => applyImport.mutate()}
                >
                  {preview.alreadyImported ? "已经导入" : "确认导入"}
                </button>
              ) : null}
            </div>
            {preview ? (
              <div className="atm-panel-body" style={{ marginTop: 8 }}>
                目标 {preview.objectiveCount} · 里程碑 {preview.milestoneCount} · 任务{" "}
                {preview.taskCount} · 参考记录 {preview.recordCount}
                {(preview.warnings as string[]).map((warning) => (
                  <div className="atm-row-sub" key={warning}>
                    注意：{warning}
                  </div>
                ))}
              </div>
            ) : null}
          </section>
          <MutationErrorAlert
            errors={[
              createBackup.error,
              restore.error,
              exportData.error,
              previewImport.error,
              applyImport.error,
            ]}
          />
        </div>
        <footer className="atm-modal-foot">
          <button className="atm-button" onClick={close}>
            关闭
          </button>
        </footer>
      </section>
    </div>
  );
}
