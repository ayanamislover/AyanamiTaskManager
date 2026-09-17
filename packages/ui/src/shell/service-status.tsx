export type ServiceState = "connecting" | "ok" | "error";

const labels: Record<ServiceState, string> = {
  connecting: "连接中",
  ok: "服务正常",
  error: "服务异常",
};

const tones: Record<ServiceState, string> = {
  connecting: "",
  ok: "success",
  error: "danger",
};

export function serviceState({
  error,
  loading,
}: {
  error: unknown;
  loading: boolean;
}): ServiceState {
  if (error) return "error";
  return loading ? "connecting" : "ok";
}

/**
 * 顶栏右侧的本机服务状态：只回答「后台服务连得上吗」。
 *
 * 以前这里借用任务状态徽标，连得上显示「活动」、连不上显示原始枚举 `MIGRATION_FAILED`——
 * 前者看不出指什么，后者把读不到项目列表的任何原因都说成迁移失败。
 */
export function ServiceStatus({ error, loading }: { error: unknown; loading: boolean }) {
  const state = serviceState({ error, loading });
  const detail =
    state === "error"
      ? `无法读取项目列表：${error instanceof Error ? error.message : String(error)}`
      : undefined;
  return (
    <span
      className={`atm-badge atm-service-status ${tones[state]}`.trim()}
      data-state={state}
      role="status"
      title={detail}
    >
      {labels[state]}
    </span>
  );
}
