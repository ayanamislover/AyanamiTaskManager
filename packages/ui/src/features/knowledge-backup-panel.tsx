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
      notify("知识库备份已创建并校验");
    },
  });
  const restore = useMutation({
    mutationFn: (id: string) => client.backups.restore(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      notify("知识库已从备份恢复");
    },
  });
  const knowledgeBackups = (backups.data ?? []).filter((backup) => backup.scope === "KNOWLEDGE");
  // ATM 3 的备份是整库的（scope STORE），知识库在里面；按知识库恢复的入口还没有，不能说「会显示在这里」。
  const storeBackups = (backups.data ?? []).filter((backup) => backup.scope === "STORE");
  return (
    <section className="atm-panel" data-testid="knowledge-backup-panel">
      <MutationErrorAlert errors={[create.error, restore.error]} />
      <div className="atm-panel-head">
        <div>
          <h2>知识库备份</h2>
          <div className="atm-row-sub">
            {storeBackups.length && !knowledgeBackups.length
              ? "立即备份会备份整个本地数据库，知识库在其中。"
              : "仅备份本地共享知识数据库，不依赖项目是否存在。"}
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
      ) : storeBackups.length ? (
        <Empty
          title="知识库在整库备份里"
          text={`备份是整库的，知识库随整库一起备份（已有 ${storeBackups.length} 份）；按知识库单独恢复将在后续版本提供。`}
        />
      ) : (
        <Empty title="没有知识库备份" text="创建首个手动备份后会显示在这里。" />
      )}
    </section>
  );
}
