import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/icons/CheckCircle";
import type { NotificationMode } from "../contracts.js";

export function NotificationPolicy({
  value,
  onChange,
}: {
  value: NotificationMode;
  onChange: (value: NotificationMode) => void;
}) {
  return (
    <div className="atm-notification-policy">
      <div className="atm-row-title">系统通知</div>
      <div className="atm-notification-options" role="radiogroup" aria-label="系统通知级别">
        {(
          [
            ["ALL", "全部通知", "等待、阻塞、完成、异常退出和维护失败"],
            ["CRITICAL", "仅严重事件", "阻塞、Agent 异常退出和维护失败"],
            ["OFF", "不通知", "保持后台运行，不弹出系统通知"],
          ] as const
        ).map(([mode, label, description]) => {
          const selected = value === mode;
          return (
            <button
              className="atm-notification-option"
              data-selected={selected ? "true" : "false"}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(mode)}
              key={mode}
            >
              <span className="atm-notification-radio" aria-hidden="true">
                {selected ? <CheckCircle size={17} weight="fill" /> : null}
              </span>
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
