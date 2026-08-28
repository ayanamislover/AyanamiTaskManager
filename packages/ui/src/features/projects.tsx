import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "@phosphor-icons/react/dist/icons/ArrowCounterClockwise";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/icons/ArrowRight";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import type { AyanamiClient } from "@ayanami-task/client";
import { AtmSelect } from "../components/atm-select.js";
import {
  Empty,
  ErrorState,
  LoadingRows,
  MutationErrorAlert,
  PageHead,
} from "../components/async-state.js";
import { Presence, type PresenceRootProps } from "../components/presence.js";
import type { DesktopBridge, McpClient, Notify } from "../contracts.js";
import { useDialogAccessibility } from "../hooks/use-dialog-accessibility.js";
import { Status, statusLabels } from "../presentation.js";

export function ProjectWizard({
  client,
  close,
  notify,
  onCreated,
  desktop,
  ...presenceRootProps
}: {
  client: AyanamiClient;
  close: () => void;
  notify: Notify;
  onCreated: (code: string) => void;
  desktop?: DesktopBridge;
} & PresenceRootProps) {
  const queryClient = useQueryClient();
  const dialogRef = useDialogAccessibility(close, presenceRootProps["data-presence"] !== "closing");
  const [step, setStep] = useState(0);
  const [connection, setConnection] = useState<"" | "正在测试" | "连接正常">("");
  const [form, setForm] = useState({
    name: "",
    code: "",
    path: "",
    description: "",
    mode: "AUTO",
    objective: "",
    milestone: "",
  });
  const configs = useQuery({
    queryKey: ["wizard-mcp-configs"],
    queryFn: () => desktop!.getMcpConfigs!(),
    enabled: step === 2 && Boolean(desktop?.getMcpConfigs),
  });
  const install = useMutation({
    mutationFn: (target: McpClient) => desktop!.installMcp!(target),
    onSuccess: (result) => notify(`Agent 配置已安装：${result.path}`),
    onError: (error) =>
      notify(`Agent 配置安装失败：${error instanceof Error ? error.message : String(error)}`),
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const project = await client.projects.create({
        name: form.name,
        sourcePath: form.path.trim() || null,
        description: form.description,
        coordinationMode: form.mode as "SOLO" | "AUTO" | "MULTI",
        ...(form.code.trim() ? { code: form.code.trim() } : {}),
      });
      if (form.objective.trim()) {
        const objective = await client.projects.createObjectiveAsUser(project.code, {
          opId: `ui-objective-${crypto.randomUUID()}`,
          title: form.objective.trim(),
          description: "",
          definitionOfDone: [],
        });
        if (form.milestone.trim())
          await client.projects.createMilestoneAsUser(project.code, {
            opId: `ui-milestone-${crypto.randomUUID()}`,
            objectiveId: objective.id,
            title: form.milestone.trim(),
            description: "",
          });
      }
      return project;
    },
    onSuccess: async (project) => {
      await queryClient.invalidateQueries();
      notify(`已创建项目 ${project.code}`);
      close();
      onCreated(project.code);
    },
  });
  const field = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <div {...presenceRootProps} className="atm-modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="atm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-wizard-title"
        tabIndex={-1}
      >
        <header className="atm-modal-head">
          <h2 id="project-wizard-title">新建项目</h2>
          <button className="atm-button atm-icon-button" aria-label="关闭" onClick={close}>
            <X size={17} />
          </button>
        </header>
        <div className="atm-modal-body">
          <div className="atm-actions" style={{ marginBottom: 20 }}>
            <span className={`atm-badge ${step === 0 ? "primary" : ""}`}>选择与配置</span>
            <span className={`atm-badge ${step === 1 ? "primary" : ""}`}>目标与里程碑</span>
            <span className={`atm-badge ${step === 2 ? "primary" : ""}`}>接入 Agent</span>
          </div>
          {step === 0 ? (
            <div className="atm-form">
              <div className="atm-form-grid">
                <div className="atm-field">
                  <label htmlFor="project-name">项目名称</label>
                  <input
                    id="project-name"
                    value={form.name}
                    onChange={(e) => field("name", e.target.value)}
                    data-dialog-autofocus
                  />
                </div>
                <div className="atm-field">
                  <label htmlFor="project-code">短代码</label>
                  <input
                    id="project-code"
                    value={form.code}
                    onChange={(e) => field("code", e.target.value.toUpperCase())}
                    placeholder="留空自动生成"
                  />
                </div>
              </div>
              <div className="atm-field">
                <label htmlFor="project-path">源码目录</label>
                <input
                  id="project-path"
                  value={form.path}
                  onChange={(e) => field("path", e.target.value)}
                  placeholder="可留空，适合研究或纯文档项目"
                />
                <small>正式项目数据会分配到受管目录，不会写入源码目录。</small>
              </div>
              <div className="atm-field">
                <label htmlFor="project-description">简短目标</label>
                <textarea
                  id="project-description"
                  value={form.description}
                  onChange={(e) => field("description", e.target.value)}
                />
              </div>
              <div className="atm-field">
                <label htmlFor="project-mode">协作模式</label>
                <AtmSelect
                  id="project-mode"
                  ariaLabel="协作模式"
                  value={form.mode}
                  options={[
                    { value: "SOLO", label: "单 Agent" },
                    { value: "AUTO", label: "自动判断" },
                    { value: "MULTI", label: "多 Agent" },
                  ]}
                  onChange={(mode) => field("mode", mode)}
                />
              </div>
            </div>
          ) : step === 1 ? (
            <div className="atm-form">
              <div className="atm-field">
                <label htmlFor="project-objective">当前目标</label>
                <input
                  id="project-objective"
                  value={form.objective}
                  onChange={(e) => field("objective", e.target.value)}
                  data-dialog-autofocus
                />
                <small>可以暂时留空，但创建正式任务前必须有活动目标。</small>
              </div>
              <div className="atm-field">
                <label htmlFor="project-milestone">首个里程碑</label>
                <input
                  id="project-milestone"
                  value={form.milestone}
                  onChange={(e) => field("milestone", e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div className="atm-form">
              <div className="atm-row">
                <div>
                  <div className="atm-row-title">{form.name}</div>
                  <div className="atm-row-sub">
                    {form.code || "自动短代码"} · {statusLabels[form.mode] ?? form.mode} ·{" "}
                    {form.path || "无目录项目"}
                  </div>
                </div>
                <Status value={connection === "连接正常" ? "ACTIVE" : "UNKNOWN"} />
              </div>
              {desktop?.getMcpConfigs ? (
                <>
                  <div className="atm-row-sub">
                    MCP 服务将在项目创建后通过同一本地服务识别该项目。
                  </div>
                  <div className="atm-actions">
                    <button
                      className="atm-button"
                      disabled={install.isPending || !desktop.installMcp}
                      onClick={() => install.mutate("CODEX")}
                    >
                      安装到 Codex
                    </button>
                    <button
                      className="atm-button"
                      disabled={install.isPending || !desktop.installMcp}
                      onClick={() => install.mutate("CLAUDE")}
                    >
                      安装到 Claude Desktop
                    </button>
                    <button
                      className="atm-button"
                      disabled={install.isPending || !desktop.installMcp}
                      onClick={() => install.mutate("CLAUDE_CODE")}
                    >
                      安装到 Claude Code
                    </button>
                    <button
                      className="atm-button"
                      disabled={!configs.data || !desktop.copyText}
                      onClick={() => void desktop.copyText!(configs.data!.stdio)}
                    >
                      复制通用配置
                    </button>
                    <button
                      className="atm-button"
                      onClick={async () => {
                        setConnection("正在测试");
                        await client.status();
                        setConnection("连接正常");
                      }}
                    >
                      运行连接测试
                    </button>
                  </div>
                  <div className="atm-row-sub">
                    {connection || (configs.isLoading ? "正在读取 MCP 配置" : "等待连接测试")}
                  </div>
                </>
              ) : (
                <div className="atm-row-sub">
                  浏览器预览模式可创建项目；Agent 自动安装请在桌面应用设置中完成。
                </div>
              )}
            </div>
          )}
          <MutationErrorAlert errors={[mutation.error, install.error]} style={{ marginTop: 14 }} />
        </div>
        <footer className="atm-modal-foot">
          {step > 0 ? (
            <button className="atm-button" onClick={() => setStep(step - 1)}>
              上一步
            </button>
          ) : null}
          {step < 2 ? (
            <button
              className="atm-button primary"
              disabled={step === 0 && !form.name.trim()}
              onClick={() => setStep(step + 1)}
            >
              下一步 <ArrowRight size={16} />
            </button>
          ) : (
            <button
              className="atm-button primary"
              disabled={!form.name.trim() || mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? "正在创建" : "创建并打开项目"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

export function ProjectsPage({
  client,
  onProject,
  notify,
  desktop,
}: {
  client: AyanamiClient;
  onProject: (code: string) => void;
  notify: Notify;
  desktop?: DesktopBridge;
}) {
  const [wizard, setWizard] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["projects"], queryFn: () => client.projects.list() });
  const restore = useMutation({
    mutationFn: (code: string) => client.projects.restore(code),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries();
      notify(`已从垃圾箱恢复 ${project.code}`);
    },
  });
  return (
    <>
      <PageHead
        title="项目"
        description="每个正式项目拥有独立 SQLite 文件和可移动的路径别名。"
        actions={
          <button className="atm-button primary" onClick={() => setWizard(true)}>
            <Plus size={16} />
            新建项目
          </button>
        }
      />
      {query.isLoading ? (
        <LoadingRows count={5} />
      ) : query.error ? (
        <ErrorState error={query.error} />
      ) : query.data!.length === 0 ? (
        <section className="atm-panel">
          <Empty
            title="还没有项目"
            text="创建项目后，可以组织目标、里程碑和任务。"
            action={
              <button className="atm-button primary" onClick={() => setWizard(true)}>
                创建第一个项目
              </button>
            }
          />
        </section>
      ) : (
        <section className="atm-project-grid">
          {query.data!.map((project) => (
            <article className="atm-project" key={project.id}>
              <button
                className="atm-project-main"
                disabled={project.lifecycle === "TRASHED"}
                onClick={() => onProject(project.code)}
              >
                <div>
                  <span className="atm-project-code">{project.code}</span>
                  <Status value={project.lifecycle} />
                </div>
                <h2>{project.name}</h2>
                <p>{project.description || "尚未填写项目说明"}</p>
                <div className="atm-project-footer">
                  <span className="atm-row-sub">{project.sourcePaths[0] ?? "无源码目录"}</span>
                  {project.lifecycle === "TRASHED" ? null : <ArrowRight size={18} />}
                </div>
              </button>
              {project.lifecycle === "TRASHED" ? (
                <button
                  className="atm-button"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(project.code)}
                >
                  <ArrowCounterClockwise size={16} />
                  恢复项目
                </button>
              ) : null}
            </article>
          ))}
        </section>
      )}
      <MutationErrorAlert error={restore.error} />
      <Presence present={wizard} inertWhenClosing>
        {wizard ? (
          <ProjectWizard
            client={client}
            close={() => setWizard(false)}
            notify={notify}
            onCreated={onProject}
            {...(desktop ? { desktop } : {})}
          />
        ) : null}
      </Presence>
    </>
  );
}
