import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { useDialogs } from "../components/atm-dialogs.js";
import { Empty, ErrorState, LoadingRows, MutationErrorAlert } from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import { formatTime } from "../presentation.js";

export function KnowledgeBackupPanel({
  client,
  notify,
}: {
  client: AyanamiClient;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const dialogs = useDialogs();
  const [visibleLimit, setVisibleLimit] = useState(8);
  const backups = useQuery({
    queryKey: ["backups", "knowledge"],
    queryFn: () => client.backups.list(),
  });
  const create = useMutation({
    mutationFn: () => client.backups.createKnowledge(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["backups", "knowledge"] });
      notify("备份已创建并校验");
    },
  });
  const restore = useMutation({
    // 只恢复知识库：3.0 的备份是整库的，要指明范围（2.0 忽略这个请求体）。
    mutationFn: (id: string) => client.backups.restore(id, { scope: "KNOWLEDGE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      notify("知识库已从备份恢复");
    },
  });
  // 2.x 的知识库备份留在旧数据目录里，只读：合并进知识库，已有的条目不覆盖（W6c）。
  const legacy = useQuery({
    queryKey: ["import-sources"],
    queryFn: () => client.data.importSources(),
  });
  const legacyKnowledge = (legacy.data?.legacyBackups ?? []).filter(
    (backup) => backup.importable === "AS_KNOWLEDGE",
  );
  const importLegacy = useMutation({
    mutationFn: async (id: string) => {
      const source = { kind: "LEGACY_BACKUP" as const, id };
      const preview = await client.data.previewImport(source);
      const fresh = (preview.newEntries as string[] | undefined) ?? [];
      const existing = (preview.existingEntries as string[] | undefined) ?? [];
      const confirmed = await dialogs.confirm({
        title: "导入 2.x 知识库备份",
        message: `将新增 ${fresh.length} 条知识；${existing.length} 条已在知识库里，保持不变。继续吗？`,
        confirmLabel: "导入",
      });
      return confirmed ? client.data.applyImport(source) : null;
    },
    onSuccess: async (result) => {
      if (!result) return;
      await queryClient.invalidateQueries();
      const inserted = (result.inserted as string[] | undefined)?.length ?? 0;
      const skipped = (result.skipped as string[] | undefined)?.length ?? 0;
      notify(`知识库已合并：新增 ${inserted} 条，跳过 ${skipped} 条`);
    },
  });
  // 2.0 的知识库备份是 KNOWLEDGE；3.0 的备份是整库的（STORE），知识库在里面，按知识库范围恢复（peer W5 r2）。
  const knowledgeBackups = (backups.data ?? []).filter(
    (backup) => backup.scope === "KNOWLEDGE" || backup.scope === "STORE",
  );
  return (
    <section className="atm-panel" data-testid="knowledge-backup-panel">
      <MutationErrorAlert errors={[create.error, restore.error, importLegacy.error]} />
      <div className="atm-panel-head">
        <div>
          <h2>知识库备份</h2>
          <div className="atm-row-sub">
            备份包含本地共享知识库，恢复时只替换知识库，不依赖项目是否存在。
          </div>
        </div>
        <button
          className="atm-button primary"
          type="button"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "备份中…" : "立即备份"}
        </button>
      </div>
      {backups.isLoading ? (
        <LoadingRows count={2} />
      ) : backups.error ? (
        <div className="atm-panel-body">
          <ErrorState error={backups.error} />
        </div>
      ) : knowledgeBackups.length ? (
        <>
          <div className="atm-list">
            {knowledgeBackups.slice(0, visibleLimit).map((backup) => (
              <div className="atm-row" key={String(backup.id)}>
                <div>
                  <div className="atm-row-title">
                    {backup.scope === "STORE" ? "整库备份 · " : ""}
                    {String(backup.reason ?? "手动备份")} ·{" "}
                    {(Number(backup.sizeBytes ?? 0) / 1024).toFixed(1)} KB
                  </div>
                  <div className="atm-row-sub">
                    {formatTime(String(backup.createdAt ?? ""))} ·{" "}
                    {backup.verifiedAt ? "已验证" : "未验证"}
                  </div>
                </div>
                <button
                  className="atm-button danger"
                  type="button"
                  disabled={restore.isPending}
                  onClick={async () => {
                    if (
                      await dialogs.confirm({
                        title: "恢复知识库",
                        message: "恢复会先备份当前知识库，然后替换为所选快照。继续吗？",
                        confirmLabel: "恢复",
                        tone: "danger",
                      })
                    )
                      restore.mutate(String(backup.id));
                  }}
                >
                  恢复
                </button>
              </div>
            ))}
          </div>
          {knowledgeBackups.length > visibleLimit ? (
            <div className="atm-panel-body">
              <button
                className="atm-button"
                type="button"
                onClick={() =>
                  setVisibleLimit((limit) => Math.min(limit + 8, knowledgeBackups.length))
                }
              >
                {visibleLimit + 8 >= knowledgeBackups.length ? "显示全部备份" : "加载更多备份"}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <Empty title="没有知识库备份" text="创建首个手动备份后会显示在这里。" />
      )}
      {legacyKnowledge.length ? (
        <>
          <div className="atm-panel-body">
            <h3>2.x 知识库备份</h3>
            <div className="atm-row-sub">
              旧版本留下的备份，只读。导入时合并进知识库，已有的条目保持不变。
            </div>
          </div>
          <div className="atm-list" data-testid="legacy-knowledge-backups">
            {legacyKnowledge.map((backup) => (
              <div className="atm-row" key={String(backup.id)}>
                <div>
                  <div className="atm-row-title">
                    {String(backup.reason ?? "2.x 备份")} ·{" "}
                    {(Number(backup.sizeBytes ?? 0) / 1024).toFixed(1)} KB
                  </div>
                  <div className="atm-row-sub">{formatTime(String(backup.createdAt ?? ""))}</div>
                </div>
                <button
                  className="atm-button"
                  type="button"
                  disabled={importLegacy.isPending}
                  onClick={() => importLegacy.mutate(String(backup.id))}
                >
                  合并进知识库
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
