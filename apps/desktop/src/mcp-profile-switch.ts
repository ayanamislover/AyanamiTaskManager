import type {
  InstalledMcpProfileLaunches,
  McpClient,
  McpProfile,
} from "@ayanami-task/agent-config";

export type McpProfileSyncStatus =
  | "SKIPPED"
  | "UPDATED"
  | "FAILED"
  | "ROLLED_BACK"
  | "ROLLBACK_FAILED";

export type McpProfileSyncAdapter = {
  client: McpClient;
  target: string;
  present: boolean;
  previousProfiles: readonly McpProfile[];
  apply: (profiles: readonly McpProfile[]) => void;
};

export type McpProfileSyncResult = {
  client: McpClient;
  target: string;
  status: McpProfileSyncStatus;
  error?: string;
  rollbackStatus?: "ROLLED_BACK" | "ROLLBACK_FAILED";
  rollbackError?: string;
};

export type McpProfileSwitchReport = {
  enabled: boolean;
  status: "APPLIED" | "FAILED" | "PARTIAL";
  restartRequired: boolean;
  clients: McpProfileSyncResult[];
};

export class McpProfileSwitchError extends Error {
  readonly code: "MCP_PROFILE_SWITCH_FAILED" | "MCP_PROFILE_SWITCH_PARTIAL";
  readonly report: McpProfileSwitchReport;

  constructor(report: McpProfileSwitchReport, cause: unknown) {
    const code =
      report.status === "PARTIAL" ? "MCP_PROFILE_SWITCH_PARTIAL" : "MCP_PROFILE_SWITCH_FAILED";
    const detail = report.clients
      .filter((entry) => entry.status === "FAILED" || entry.status === "ROLLBACK_FAILED")
      .map((entry) => `${entry.target}=${entry.status}${entry.error ? `(${entry.error})` : ""}`)
      .join(", ");
    super(
      `${code}: ${cause instanceof Error ? cause.message : String(cause)}${detail ? `; ${detail}` : ""}`,
      { cause },
    );
    this.name = "McpProfileSwitchError";
    this.code = code;
    this.report = report;
  }
}

/** 只有持久化的布尔 false 才表示主动低内存降级；缺省与损坏值均保留完整能力。 */
export function memoryProfileEnabledValue(value: unknown): boolean {
  return value !== false;
}

export function hasManagedMcpProfile(launches: InstalledMcpProfileLaunches): boolean {
  return launches.legacy !== null || launches.core !== null || launches.memory !== null;
}

/** legacy 兼容入口包含完整工具面，所以失败回滚时按双 Profile 恢复它的能力。 */
export function profilesRepresentedBy(
  launches: InstalledMcpProfileLaunches,
): readonly McpProfile[] {
  return launches.legacy !== null || launches.memory !== null
    ? (["core", "memory"] as const)
    : (["core"] as const);
}

function baseResults(adapters: readonly McpProfileSyncAdapter[]): McpProfileSyncResult[] {
  return adapters.map((adapter) => ({
    client: adapter.client,
    target: adapter.target,
    status: "SKIPPED",
  }));
}

function failureReport(
  enabled: boolean,
  results: McpProfileSyncResult[],
  partial: boolean,
): McpProfileSwitchReport {
  return {
    enabled,
    status: partial ? "PARTIAL" : "FAILED",
    restartRequired: true,
    clients: results,
  };
}

/**
 * 用户触发的开关是一个小事务：客户端全部同步成功后才提交偏好。
 * 某个客户端或偏好提交失败时，回滚所有可能被触碰的客户端；回滚失败必须显式 PARTIAL。
 */
export function runMcpProfileSwitch(input: {
  enabled: boolean;
  adapters: readonly McpProfileSyncAdapter[];
  commit: () => void;
}): McpProfileSwitchReport {
  const desired: readonly McpProfile[] = input.enabled
    ? (["core", "memory"] as const)
    : (["core"] as const);
  const results = baseResults(input.adapters);
  const applied: number[] = [];

  const rollback = (indices: readonly number[]): boolean => {
    let partial = false;
    const unique = [...new Set(indices)];
    for (const index of unique) {
      const adapter = input.adapters[index]!;
      const previous = results[index]!;
      try {
        adapter.apply(adapter.previousProfiles);
        results[index] =
          previous.status === "FAILED"
            ? { ...previous, rollbackStatus: "ROLLED_BACK" }
            : { client: adapter.client, target: adapter.target, status: "ROLLED_BACK" };
      } catch (error) {
        partial = true;
        const rollbackError = error instanceof Error ? error.message : String(error);
        results[index] =
          previous.status === "FAILED"
            ? { ...previous, rollbackStatus: "ROLLBACK_FAILED", rollbackError }
            : {
                client: adapter.client,
                target: adapter.target,
                status: "ROLLBACK_FAILED",
                error: rollbackError,
              };
      }
    }
    return partial;
  };

  for (const [index, adapter] of input.adapters.entries()) {
    if (!adapter.present) continue;
    try {
      adapter.apply(desired);
      applied.push(index);
      results[index] = { client: adapter.client, target: adapter.target, status: "UPDATED" };
    } catch (error) {
      results[index] = {
        client: adapter.client,
        target: adapter.target,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      };
      const partial = rollback([index, ...applied.slice().reverse()]);
      throw new McpProfileSwitchError(failureReport(input.enabled, results, partial), error);
    }
  }

  try {
    input.commit();
  } catch (error) {
    const partial = rollback(applied.slice().reverse());
    throw new McpProfileSwitchError(failureReport(input.enabled, results, partial), error);
  }

  return { enabled: input.enabled, status: "APPLIED", restartRequired: true, clients: results };
}
