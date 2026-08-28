import { useEffect, useState, type ReactNode } from "react";
import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon as Archive } from "@phosphor-icons/react/dist/icons/Archive";
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "@phosphor-icons/react/dist/icons/ArrowCounterClockwise";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/icons/ArrowRight";
import { PlayIcon as Play } from "@phosphor-icons/react/dist/icons/Play";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import {
  AyanamiClient,
  type RegisteredProject,
  type UserRecordCreateInput,
} from "@ayanami-task/client";
import { createAyanamiQueryClient } from "./query-policy.js";
import { recordDraftToUserInput } from "./record-input.js";
import { useCursorCollection } from "./cursor-collection.js";
import { AtmSelect } from "./components/atm-select.js";
import { Empty, ErrorState, LoadingRows, PageHead } from "./components/async-state.js";
import { useDialogAccessibility } from "./hooks/use-dialog-accessibility.js";
import { useAppShortcuts } from "./hooks/use-app-shortcuts.js";
import { useNotice } from "./hooks/use-notice.js";
import { useTheme } from "./hooks/use-theme.js";
import { AppShell } from "./shell/app-shell.js";
import { AgentsPage } from "./features/agents.js";
import { OverviewPage, TasksAcrossProjects } from "./features/overview.js";
import { ProjectSummary } from "./features/project-summary.js";
import { ProjectTaskControls, useProjectTaskViewState } from "./features/project-task-controls.js";
import { ProjectTaskViews } from "./features/project-task-views.js";
import { ProjectsPage } from "./features/projects.js";
import { QuickPage } from "./features/quick.js";
import { SettingsPage } from "./features/settings.js";
import { TaskDrawer } from "./features/task-drawer.js";
import { GlobalTimelinePage, TimelineEventRow } from "./features/timeline.js";
import {
  appRouteTitle,
  useAppRouteState,
  useDesktopRouteNavigation,
  useRouteHash,
} from "./routes/use-app-route.js";
import type { AyanamiTaskManagerProps, DesktopBridge, Notify } from "./contracts.js";
import { Status, formatTime, statusLabels } from "./presentation.js";
import "./styles.css";

function CreateTaskModal({
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
            {mutation.error ? (
              <div className="atm-inline-error">
                {mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
              </div>
            ) : null}
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

function CreateRecordModal({
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
  const [kind, setKind] = useState<UserRecordCreateInput["kind"]>("DECISION");
  const [importance, setImportance] =
    useState<NonNullable<UserRecordCreateInput["importance"]>>("NORMAL");
  const [topic, setTopic] = useState("");
  const [subjectKey, setSubjectKey] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      client.recordAsUser(
        project,
        recordDraftToUserInput({
          opId: `ui-record-${crypto.randomUUID()}`,
          kind,
          importance,
          title,
          summary,
          detail,
          topic,
          subjectKey,
        }),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["records", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      notify("项目记录已保存");
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
        aria-labelledby="record-modal-title"
        tabIndex={-1}
      >
        <header className="atm-modal-head">
          <h2 id="record-modal-title">新建项目记录</h2>
          <button className="atm-button atm-icon-button" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="atm-modal-body atm-form">
          <div className="atm-form-grid">
            <div className="atm-field">
              <label htmlFor="record-kind">类型</label>
              <AtmSelect
                id="record-kind"
                ariaLabel="记录类型"
                value={kind}
                options={[
                  { value: "DECISION", label: "决策" },
                  { value: "CONSTRAINT", label: "约束" },
                  { value: "FACT", label: "事实" },
                  { value: "RISK", label: "风险" },
                  { value: "REFERENCE", label: "参考" },
                  { value: "LESSON", label: "经验" },
                  { value: "VERIFICATION", label: "验证" },
                  { value: "WAIVER", label: "豁免" },
                ]}
                onChange={(value) => setKind(value as UserRecordCreateInput["kind"])}
              />
            </div>
            <div className="atm-field">
              <label htmlFor="record-importance">重要性</label>
              <AtmSelect
                id="record-importance"
                ariaLabel="记录重要性"
                value={importance}
                options={[
                  { value: "LOW", label: "低" },
                  { value: "NORMAL", label: "普通" },
                  { value: "HIGH", label: "高" },
                  { value: "CRITICAL", label: "紧急" },
                ]}
                onChange={(value) =>
                  setImportance(value as NonNullable<UserRecordCreateInput["importance"]>)
                }
              />
            </div>
          </div>
          <div className="atm-field">
            <label htmlFor="record-topic">主题（可选，用于发现相关记录）</label>
            <input
              id="record-topic"
              value={topic}
              maxLength={200}
              placeholder="例如：release/1.0.16 或 review/candidate-a"
              onChange={(event) => setTopic(event.target.value)}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="record-subject-key">主题标识（可选）</label>
            <input
              id="record-subject-key"
              value={subjectKey}
              maxLength={200}
              placeholder="例如：candidate:release-v1"
              onChange={(event) => setSubjectKey(event.target.value)}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="record-title">标题</label>
            <input
              id="record-title"
              data-dialog-autofocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="record-summary">摘要</label>
            <textarea
              id="record-summary"
              maxLength={300}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="record-detail">详细内容</label>
            <textarea
              id="record-detail"
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
            />
          </div>
          {mutation.error ? (
            <div className="atm-inline-error">
              {mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
            </div>
          ) : null}
        </div>
        <footer className="atm-modal-foot">
          <button className="atm-button" onClick={close}>
            取消
          </button>
          <button
            className="atm-button primary"
            disabled={!title.trim() || !summary.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            保存记录
          </button>
        </footer>
      </section>
    </div>
  );
}

function ProjectUpdateModal({
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
  const history = useQuery({
    queryKey: ["project-updates", project],
    queryFn: () => client.projects.updates(project),
  });
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [health, setHealth] = useState("UNKNOWN");
  const [summary, setSummary] = useState("");
  const generate = useMutation({
    mutationFn: () => client.projects.draftUpdate(project, `ui-draft-${crypto.randomUUID()}`),
    onSuccess: (value) => {
      setDraft(value);
      setHealth(String(value.health));
      setSummary(String(value.summary));
    },
  });
  const publish = useMutation({
    mutationFn: () =>
      client.projects.publishUpdate(project, {
        opId: `ui-publish-${crypto.randomUUID()}`,
        draftId: draft?.id,
        health,
        summary,
        completed: draft?.completed ?? [],
        risks: draft?.risks ?? [],
        next: draft?.next ?? [],
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project-updates", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["brief", project] }),
      ]);
      notify("项目更新已发布");
      close();
    },
  });
  const error = generate.error ?? publish.error;
  return (
    <div className="atm-modal-backdrop">
      <section
        ref={dialogRef}
        className="atm-modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-update-title"
        tabIndex={-1}
      >
        <header className="atm-modal-head">
          <h2 id="project-update-title">发布项目更新</h2>
          <button className="atm-button atm-icon-button" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="atm-modal-body atm-form">
          {!draft ? (
            <section className="atm-panel">
              <Empty
                title="生成确定性草稿"
                text="系统根据上次发布后的完成项、当前风险和下一批活动任务生成草稿。"
                action={
                  <button
                    className="atm-button primary"
                    disabled={generate.isPending}
                    onClick={() => generate.mutate()}
                  >
                    {generate.isPending ? "正在生成" : "生成更新草稿"}
                  </button>
                }
              />
            </section>
          ) : (
            <>
              <div className="atm-field">
                <label htmlFor="project-health">项目健康度</label>
                <AtmSelect
                  id="project-health"
                  ariaLabel="项目健康度"
                  value={health}
                  options={[
                    { value: "UNKNOWN", label: "未知" },
                    { value: "ON_TRACK", label: "正常" },
                    { value: "AT_RISK", label: "有风险" },
                    { value: "OFF_TRACK", label: "偏离计划" },
                  ]}
                  onChange={setHealth}
                />
              </div>
              <div className="atm-field">
                <label htmlFor="project-update-summary">当前判断</label>
                <textarea
                  id="project-update-summary"
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                />
              </div>
              <div className="atm-form-grid">
                <div className="atm-panel-body">
                  <strong>已完成</strong>
                  {(draft.completed as string[]).length ? (
                    (draft.completed as string[]).map((item) => (
                      <div className="atm-row-sub" key={item}>
                        · {item}
                      </div>
                    ))
                  ) : (
                    <div className="atm-row-sub">暂无新增完成项</div>
                  )}
                </div>
                <div className="atm-panel-body">
                  <strong>风险</strong>
                  {(draft.risks as string[]).length ? (
                    (draft.risks as string[]).map((item) => (
                      <div className="atm-row-sub" key={item}>
                        · {item}
                      </div>
                    ))
                  ) : (
                    <div className="atm-row-sub">当前无阻塞风险</div>
                  )}
                </div>
              </div>
              <div className="atm-panel-body">
                <strong>下一步</strong>
                {(draft.next as string[]).map((item) => (
                  <div className="atm-row-sub" key={item}>
                    · {item}
                  </div>
                ))}
              </div>
            </>
          )}
          {history.data?.some((item) => item.status === "PUBLISHED") ? (
            <section className="atm-section">
              <h3>最近发布</h3>
              {history.data
                .filter((item) => item.status === "PUBLISHED")
                .slice(0, 3)
                .map((item) => (
                  <div className="atm-row" key={item.id}>
                    <div>
                      <div className="atm-row-title">{item.summary}</div>
                      <div className="atm-row-sub">
                        {formatTime(item.publishedAt)} · {statusLabels[item.health] ?? item.health}
                      </div>
                    </div>
                  </div>
                ))}
            </section>
          ) : null}
          {error ? (
            <div className="atm-inline-error">
              {error instanceof Error ? error.message : String(error)}
            </div>
          ) : null}
        </div>
        <footer className="atm-modal-foot">
          <button className="atm-button" onClick={close}>
            取消
          </button>
          {draft ? (
            <button
              className="atm-button primary"
              disabled={!summary.trim() || publish.isPending}
              onClick={() => publish.mutate()}
            >
              发布更新
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function ProjectDataModal({
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
  const busyError =
    createBackup.error ??
    restore.error ??
    exportData.error ??
    previewImport.error ??
    applyImport.error;
  return (
    <div className="atm-modal-backdrop">
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
          {busyError ? (
            <div className="atm-inline-error">
              {busyError instanceof Error ? busyError.message : String(busyError)}
            </div>
          ) : null}
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

function ProjectPage({
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

function CommandPalette({
  client,
  close,
  onProject,
  onTask,
}: {
  client: AyanamiClient;
  close: () => void;
  onProject: (code: string) => void;
  onTask: (project: string, key: string) => void;
}) {
  const dialogRef = useDialogAccessibility(close);
  const [query, setQuery] = useState("");
  const result = useQuery({
    queryKey: ["search", query],
    queryFn: () => client.search(query),
    enabled: query.trim().length > 0,
  });
  const hits = ((result.data as any)?.hits ?? []) as any[];
  return (
    <div
      className="atm-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="atm-modal atm-command"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
        tabIndex={-1}
      >
        <input
          data-dialog-autofocus
          aria-label="全局搜索"
          placeholder="搜索任务、记录、阻塞和临时任务"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && result.isLoading ? (
          <LoadingRows count={3} />
        ) : query && result.error ? (
          <ErrorState error={result.error} />
        ) : query && hits.length === 0 ? (
          <Empty title="没有搜索结果" text="换一个更短或更具体的关键词。" />
        ) : (
          <div className="atm-command-results">
            {hits.map((hit, index) => (
              <button
                className="atm-row"
                key={`${hit.entity_key}:${index}`}
                onClick={() => {
                  if (hit.entity_type === "WORK_ITEM" && hit.project)
                    onTask(hit.project, hit.entity_key);
                  else if (hit.project) onProject(hit.project);
                  close();
                }}
              >
                <div>
                  <div className="atm-row-title">{hit.title}</div>
                  <div className="atm-row-sub">
                    {hit.entity_key} · {hit.project ?? "临时任务"}
                  </div>
                </div>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function App({
  client,
  desktop,
  brandLogoSrc,
}: {
  client: AyanamiClient;
  desktop?: DesktopBridge;
  brandLogoSrc?: string;
}) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => client.projects.list() });
  const [route, setRoute] = useAppRouteState();
  const [palette, setPalette] = useState(false);
  const [drawer, setDrawer] = useState<{ project: string; key: string } | null>(null);
  const { notice, notify } = useNotice();
  useRouteHash(route);
  const { theme, toggleTheme } = useTheme();
  useDesktopRouteNavigation(desktop, setRoute);
  useAppShortcuts(route, setRoute, setPalette);
  const projectList = projects.data ?? [];
  const selectedProject = route.startsWith("project:")
    ? projectList.find((project) => project.code === route.slice(8))
    : null;
  const openTask = (project: string, key: string) => {
    setRoute(`project:${project}`);
    setDrawer({ project, key });
  };
  const title = appRouteTitle(route, selectedProject?.name);
  let page: ReactNode;
  if (route === "overview")
    page = (
      <OverviewPage
        client={client}
        onProject={(code) => setRoute(`project:${code}`)}
        onQuick={() => setRoute("quick")}
        notify={notify}
        TimelineEventRow={TimelineEventRow}
      />
    );
  else if (route === "projects")
    page = (
      <ProjectsPage
        client={client}
        onProject={(code) => setRoute(`project:${code}`)}
        notify={notify}
        {...(desktop ? { desktop } : {})}
      />
    );
  else if (route === "my")
    page = (
      <>
        <PageHead title="活动任务" description="所有正式项目中已领取、进行中和验收中的任务。" />
        <TasksAcrossProjects
          client={client}
          projects={projectList}
          mode="active"
          onTask={openTask}
        />
      </>
    );
  else if (route === "quick") page = <QuickPage client={client} notify={notify} />;
  else if (route === "blockers")
    page = (
      <>
        <PageHead
          title="阻塞与等待"
          description="集中处理被阻塞、等待用户或等待其他 Agent 的工作。"
        />
        <TasksAcrossProjects
          client={client}
          projects={projectList}
          mode="blocked"
          onTask={openTask}
        />
      </>
    );
  else if (route === "agents") page = <AgentsPage client={client} projects={projectList} />;
  else if (route === "timeline") page = <GlobalTimelinePage client={client} />;
  else if (route === "settings")
    page = <SettingsPage client={client} {...(desktop === undefined ? {} : { desktop })} />;
  else if (selectedProject)
    page = (
      <ProjectPage
        client={client}
        project={selectedProject}
        notify={notify}
        openTask={(key) => setDrawer({ project: selectedProject.code, key })}
        onExit={() => setRoute("projects")}
        {...(desktop ? { desktop } : {})}
      />
    );
  else page = <ErrorState error="找不到这个项目，可能已被移除或路径发生变化。" />;
  return (
    <AppShell
      route={route}
      onRoute={setRoute}
      projects={projectList}
      {...(brandLogoSrc ? { brandLogoSrc } : {})}
      title={title}
      theme={theme}
      statusSlot={<Status value={projects.error ? "MIGRATION_FAILED" : "ACTIVE"} />}
      content={page}
      paletteSlot={
        palette ? (
          <CommandPalette
            client={client}
            close={() => setPalette(false)}
            onProject={(code) => setRoute(`project:${code}`)}
            onTask={openTask}
          />
        ) : null
      }
      drawerSlot={
        drawer ? (
          <TaskDrawer
            client={client}
            project={drawer.project}
            taskKey={drawer.key}
            close={() => setDrawer(null)}
            notify={notify}
          />
        ) : null
      }
      noticeSlot={notice}
      onSearch={() => setPalette(true)}
      onToggleTheme={toggleTheme}
      onCreate={() => {
        if (route.startsWith("project:")) window.dispatchEvent(new Event("atm:new-project-task"));
        else setRoute("quick");
      }}
    />
  );
}

export function AyanamiTaskManager({ client, desktop, brandLogoSrc }: AyanamiTaskManagerProps) {
  const [queryClient] = useState(() => createAyanamiQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <App
        client={client}
        {...(desktop === undefined ? {} : { desktop })}
        {...(brandLogoSrc ? { brandLogoSrc } : {})}
      />
    </QueryClientProvider>
  );
}
