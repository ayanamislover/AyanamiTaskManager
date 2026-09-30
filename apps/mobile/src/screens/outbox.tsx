import { CheckIcon as Check } from "@phosphor-icons/react/dist/icons/Check";
import { CircleNotchIcon as CircleNotch } from "@phosphor-icons/react/dist/icons/CircleNotch";
import { ExclamationMarkIcon as Exclamation } from "@phosphor-icons/react/dist/icons/ExclamationMark";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import type { LocalCommand } from "../data/commands.js";
import { findTask } from "../data/snapshot.js";
import { formatRelative } from "../data/time.js";
import { useEngine, useEngineState, useNow } from "../ui/hooks.js";
import { describeCommand, dispatchFailureReason } from "../ui/labels.js";
import { SectionTitle } from "../ui/layout.js";
import { push } from "../ui/nav.js";

/**
 * 「发出的任务」：手机发出的命令在收到电脑回执前后的状态。
 * 等待电脑接收 → 已创建 ATM-T-xxxx → Claude 排队中 / 运行中 …
 */
export function Outbox() {
  const state = useEngineState();
  const visible = state.commands
    .filter((command) => !command.dismissed)
    .slice(-5)
    .reverse();
  if (visible.length === 0) return null;
  return (
    <>
      <SectionTitle count={visible.length}>发出的任务</SectionTitle>
      <div className="outbox">
        {visible.map((command) => (
          <CommandCard key={command.doc.id} command={command} />
        ))}
      </div>
    </>
  );
}

export function CommandCard({
  command,
  compact = false,
}: {
  command: LocalCommand;
  compact?: boolean;
}) {
  const engine = useEngine();
  const state = useEngineState();
  const now = useNow(15_000);
  const result = command.result;
  const task = result ? findTask(state.snapshot, result.project, result.key) : null;
  const view = describeCommand(command, task);
  const open = command.state === "pending" || command.state === "sent";
  const canOpen = Boolean(result && task);
  const body = (
    <>
      <span className="command-dot" data-tone={view.tone} aria-hidden="true" />
      <span className="command-copy">
        <strong>{view.title}</strong>
        {view.detail ? <span className="command-detail">{view.detail}</span> : null}
      </span>
      <span className="command-time">{formatRelative(command.ackAt ?? command.doc.at, now)}</span>
    </>
  );
  return (
    <div
      className="command-card"
      data-state={command.state}
      data-compact={compact ? "true" : "false"}
    >
      {canOpen && result ? (
        <button
          type="button"
          className="command-main"
          onClick={() => push({ name: "task", code: result.project, key: result.key })}
        >
          {body}
        </button>
      ) : (
        <div className="command-main" role="status">
          {body}
        </div>
      )}
      {!open && !compact ? (
        <button
          type="button"
          className="command-dismiss"
          aria-label="从列表移除"
          onClick={() => void engine.dismiss(command.doc.id)}
        >
          <X size={14} weight="bold" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

type StepState = "done" | "active" | "todo" | "failed";
type Step = { state: StepState; label: string; mono?: string; detail?: string | null };

/**
 * 新任务发出后的三步：电脑接收 → 建出任务 → （勾了交给 Claude 时）Claude 开工。
 * 把异步过程摊开，看得出现在卡在哪一步；失败的那一步写明原因。
 */
export function CommandSteps({ command }: { command: LocalCommand }) {
  const state = useEngineState();
  const { doc, result } = command;
  const task = result ? findTask(state.snapshot, result.project, result.key) : null;
  const steps: Step[] = [];
  if (command.state === "pending") {
    steps.push({
      state: "active",
      label: command.lastError ? "暂未发出，联网后自动重试" : "正在发送…",
    });
  } else if (command.state === "sent") {
    steps.push({ state: "active", label: "等待电脑接收" });
  } else if (command.state === "failed") {
    steps.push({ state: "failed", label: command.error?.message ?? "电脑没有接受这条任务" });
  } else {
    steps.push({ state: "done", label: "电脑已接收" });
  }
  steps.push(
    result
      ? { state: "done", label: "已创建", mono: result.key }
      : { state: "todo", label: "创建任务" },
  );
  const wantsDispatch = doc.type === "task.create" && doc.body.dispatch === true;
  if (wantsDispatch) {
    const dispatch = task?.dispatch ?? (result?.dispatch ? { state: result.dispatch.state } : null);
    const reason = dispatchFailureReason(result, task);
    if (result?.dispatchError)
      steps.push({ state: "failed", label: "派单没有开始", detail: reason });
    else if (!dispatch) steps.push({ state: "todo", label: "Claude 开工" });
    else if (dispatch.state === "queued") steps.push({ state: "active", label: "Claude 排队中" });
    else if (dispatch.state === "running") steps.push({ state: "done", label: "Claude 已开工" });
    else if (dispatch.state === "succeeded") steps.push({ state: "done", label: "Claude 已完成" });
    else
      steps.push({
        state: "failed",
        label: dispatch.state === "failed" ? "Claude 运行失败" : "派单已取消",
        detail: dispatch.state === "failed" ? reason : null,
      });
  }
  return (
    <ol className="steps">
      {steps.map((step, index) => (
        <li key={index} data-state={step.state}>
          <span className="step-mark" aria-hidden="true">
            {step.state === "done" ? (
              <Check size={12} weight="bold" />
            ) : step.state === "active" ? (
              <CircleNotch size={14} weight="bold" />
            ) : step.state === "failed" ? (
              <Exclamation size={12} weight="bold" />
            ) : null}
          </span>
          <span className="step-label">
            {step.label}
            {step.mono ? <span className="mono"> {step.mono}</span> : null}
            {step.detail ? <span className="step-detail">{step.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
