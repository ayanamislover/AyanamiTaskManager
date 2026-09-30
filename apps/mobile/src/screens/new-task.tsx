import { useId, useMemo, useState } from "react";
import { PaperPlaneTiltIcon as PaperPlane } from "@phosphor-icons/react/dist/icons/PaperPlaneTilt";
import type { Priority } from "@ayanami-task/protocol";
import { sortProjects } from "../data/snapshot.js";
import { SwitchRow, Segmented } from "../ui/controls.js";
import { useEngine, useEngineState } from "../ui/hooks.js";
import { PRIORITY_ORDER, priorityLabel } from "../ui/labels.js";
import { Screen } from "../ui/layout.js";
import { pop, replaceTop } from "../ui/nav.js";
import { Select } from "../ui/select.js";
import { CommandSteps } from "./outbox.js";

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 8000;
const PRIORITY_OPTIONS = PRIORITY_ORDER.map((value) => ({ value, label: priorityLabel(value) }));

export function NewTaskScreen({ initialProject }: { initialProject?: string }) {
  const engine = useEngine();
  const state = useEngineState();
  const projects = useMemo(
    () => sortProjects(state.snapshot.head?.projects ?? []),
    [state.snapshot.head],
  );
  const dispatchEnabled = state.snapshot.head?.dispatch.enabled ?? false;
  const [project, setProject] = useState(initialProject ?? projects[0]?.code ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("NORMAL");
  const [dispatch, setDispatch] = useState(dispatchEnabled);
  const [sentId, setSentId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { project: useId(), title: useId(), description: useId() };
  const trimmed = title.trim();
  const valid = Boolean(project) && trimmed.length > 0 && trimmed.length <= TITLE_MAX;
  const sent = sentId ? state.commands.find((command) => command.doc.id === sentId) : null;

  const submit = async () => {
    if (!valid || sending) return;
    setSending(true);
    setError(null);
    try {
      const body = {
        project,
        title: trimmed,
        priority,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(dispatch && dispatchEnabled ? { dispatch: true } : {}),
      };
      setSentId(await engine.submit({ type: "task.create", body }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "没能保存这条任务，请重试");
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    const result = sent.result;
    return (
      <Screen
        title="新任务"
        footer={
          <div className="footer-pair">
            <button
              type="button"
              className="button"
              onClick={() => {
                setSentId(null);
                setTitle("");
                setDescription("");
              }}
            >
              再建一个
            </button>
            {result ? (
              <button
                type="button"
                className="button primary"
                onClick={() => replaceTop({ name: "task", code: result.project, key: result.key })}
              >
                查看任务
              </button>
            ) : (
              <button type="button" className="button primary" onClick={() => pop()}>
                回到上一页
              </button>
            )}
          </div>
        }
      >
        <div className="sent-card card">
          <span className="sent-icon" aria-hidden="true">
            <PaperPlane size={26} weight="duotone" />
          </span>
          <strong>{sent.doc.type === "task.create" ? sent.doc.body.title : ""}</strong>
          <p>
            发到 <span className="mono">{project}</span>
            。电脑在线时通常几秒内就会接收；离线时先存在这台手机上，电脑下次上线再处理。
          </p>
          <CommandSteps command={sent} />
        </div>
      </Screen>
    );
  }

  return (
    <Screen
      title="新任务"
      footer={
        <button
          type="button"
          className="button primary block"
          disabled={!valid || sending}
          onClick={() => void submit()}
        >
          <PaperPlane size={18} weight="fill" aria-hidden="true" />
          发送到电脑
        </button>
      }
    >
      {projects.length === 0 ? (
        <p className="form-hint">电脑上还没有项目，暂时不能发任务。</p>
      ) : (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="field">
            <label htmlFor={ids.project}>项目</label>
            <Select
              id={ids.project}
              label="项目"
              value={project}
              onChange={setProject}
              options={projects.map((p) => ({ value: p.code, label: p.name, hint: p.code }))}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.title}>
              标题
              {trimmed.length > TITLE_MAX - 20 ? (
                <span
                  className="field-count"
                  data-over={trimmed.length > TITLE_MAX ? "true" : "false"}
                >
                  {trimmed.length}/{TITLE_MAX}
                </span>
              ) : null}
            </label>
            <div className="input-shell field-shell">
              <input
                id={ids.title}
                value={title}
                maxLength={TITLE_MAX + 20}
                placeholder="一句话说清要做什么"
                enterKeyHint="next"
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor={ids.description}>目标描述</label>
            <div className="input-shell field-shell is-multiline">
              <textarea
                id={ids.description}
                value={description}
                maxLength={DESCRIPTION_MAX}
                rows={5}
                placeholder="想让它做成什么样？越具体越好：背景、验收标准、别碰哪些地方。"
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <span className="field-label" id={`${ids.title}-priority`}>
              优先级
            </span>
            <Segmented
              label="优先级"
              value={priority}
              options={PRIORITY_OPTIONS}
              onChange={setPriority}
            />
          </div>
          <div className="card switch-card">
            <SwitchRow
              checked={dispatch && dispatchEnabled}
              disabled={!dispatchEnabled}
              onChange={setDispatch}
              title="交给 Claude 自动开工"
              description={
                dispatchEnabled
                  ? "电脑收到后会自动启动 Claude Code 领取任务、补全目标并开工。"
                  : "电脑端未开启 Claude 派单。可以先建任务，之后在电脑上或任务详情里再交给 Claude。"
              }
            />
          </div>
          {error ? <p className="inline-error">{error}</p> : null}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
    </Screen>
  );
}
