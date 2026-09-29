export type ServiceState = "connecting" | "ok" | "error";

const labels: Record<ServiceState, string> = {
  connecting: "连接中",
  ok: "正常",
  error: "异常",
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
 * 侧栏「设置」一行右侧的本机服务状态灯：只回答「后台服务连得上吗」。
 * 看得见的是一颗灯加两个字（正常 / 连接中 / 异常）；读屏会带上「本地服务」前缀。
 *
 * 以前这里借用任务状态徽标，连得上显示「活动」、连不上显示原始枚举 `MIGRATION_FAILED`——
 * 前者看不出指什么，后者把读不到项目列表的任何原因都说成迁移失败。
 */
export function ServiceStatus({
  error,
  loading,
  inline = false,
}: {
  error: unknown;
  loading: boolean;
  /** 设置页「本地服务」一行里的版本：行标题已经写了「本地服务」，不再重复，也不当作实时播报。 */
  inline?: boolean;
}) {
  const state = serviceState({ error, loading });
  const message = error instanceof Error ? error.message : String(error);
  const detail =
    state === "error" ? (inline ? message : `无法读取项目列表：${message}`) : undefined;
  return (
    <span
      className={inline ? "atm-service-status is-inline" : "atm-service-status"}
      data-state={state}
      role={inline ? undefined : "status"}
      title={detail}
    >
      {inline ? null : <span className="atm-visually-hidden">本地服务</span>}
      {labels[state]}
    </span>
  );
}
