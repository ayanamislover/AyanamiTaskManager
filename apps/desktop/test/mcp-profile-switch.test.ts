import { describe, expect, it, vi } from "vitest";
import {
  hasManagedMcpProfile,
  memoryProfileEnabledValue,
  McpProfileSwitchError,
  profilesRepresentedBy,
  runMcpProfileSwitch,
  type McpProfileSyncAdapter,
} from "../src/mcp-profile-switch.js";

function adapter(input: Partial<McpProfileSyncAdapter> & Pick<McpProfileSyncAdapter, "client">) {
  return {
    target: input.client,
    present: true,
    previousProfiles: ["core"] as const,
    apply: vi.fn(),
    ...input,
  } satisfies McpProfileSyncAdapter;
}

describe("MCP Profile 用户切换事务", () => {
  it("只有明确 false 才进入低内存降级，未设置时默认完整三 Profile", () => {
    expect(memoryProfileEnabledValue(undefined)).toBe(true);
    expect(memoryProfileEnabledValue(true)).toBe(true);
    expect(memoryProfileEnabledValue(false)).toBe(false);
  });

  it("legacy 按完整能力回滚，正式入口按实际扩展集合回滚", () => {
    const legacy = {
      legacy: { command: "legacy.exe", args: [] },
      core: null,
      memory: null,
      actions: null,
    };
    expect(hasManagedMcpProfile(legacy)).toBe(true);
    expect(profilesRepresentedBy(legacy)).toEqual(["core", "memory", "actions"]);
    expect(
      profilesRepresentedBy({
        legacy: null,
        core: { command: "core", args: [] },
        memory: { command: "memory", args: [] },
        actions: null,
      }),
    ).toEqual(["core", "memory"]);
    expect(
      profilesRepresentedBy({
        legacy: null,
        core: { command: "core", args: [] },
        memory: null,
        actions: { command: "actions", args: [] },
      }),
    ).toEqual(["core", "actions"]);
    expect(
      profilesRepresentedBy({
        legacy: null,
        core: null,
        memory: null,
        actions: { command: "actions", args: [] },
      }),
    ).toEqual(["core", "actions"]);
    expect(hasManagedMcpProfile({ legacy: null, core: null, memory: null, actions: null })).toBe(
      false,
    );
  });

  it("先同步全部已安装客户端，全部成功后才提交偏好", () => {
    const events: string[] = [];
    const codex = adapter({
      client: "CODEX",
      apply: (profiles) => events.push(`codex:${profiles.join("+")}`),
    });
    const claude = adapter({
      client: "CLAUDE",
      previousProfiles: ["core", "memory"],
      apply: (profiles) => events.push(`claude:${profiles.join("+")}`),
    });
    const unused = adapter({ client: "CLAUDE_CODE", present: false });

    const result = runMcpProfileSwitch({
      enabled: true,
      adapters: [codex, claude, unused],
      commit: () => events.push("commit"),
    });

    expect(events).toEqual(["codex:core+memory+actions", "claude:core+memory+actions", "commit"]);
    expect(result).toMatchObject({ enabled: true, status: "APPLIED", restartRequired: true });
    expect(result.clients.map((entry) => entry.status)).toEqual(["UPDATED", "UPDATED", "SKIPPED"]);
  });

  it("任一客户端失败时不提交偏好，并按原 Profile 逆序回滚已触碰客户端", () => {
    const events: string[] = [];
    const codex = adapter({
      client: "CODEX",
      apply: (profiles) => events.push(`codex:${profiles.join("+")}`),
    });
    let claudeCalls = 0;
    const claude = adapter({
      client: "CLAUDE",
      previousProfiles: ["core", "memory"],
      apply: (profiles) => {
        claudeCalls += 1;
        events.push(`claude:${profiles.join("+")}`);
        if (claudeCalls === 1) throw new Error("CLAUDE_WRITE_FAILED");
      },
    });
    const commit = vi.fn();

    let thrown: McpProfileSwitchError | null = null;
    try {
      runMcpProfileSwitch({ enabled: false, adapters: [codex, claude], commit });
    } catch (error) {
      expect(error).toBeInstanceOf(McpProfileSwitchError);
      thrown = error as McpProfileSwitchError;
    }
    expect(thrown).not.toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(events).toEqual(["codex:core", "claude:core", "claude:core+memory", "codex:core"]);
    expect(thrown!.report.clients[1]).toMatchObject({
      client: "CLAUDE",
      status: "FAILED",
      rollbackStatus: "ROLLED_BACK",
      error: "CLAUDE_WRITE_FAILED",
    });
    expect(thrown!.message).toContain("CLAUDE=FAILED(CLAUDE_WRITE_FAILED)");
  });

  it("偏好提交失败也回滚客户端；回滚失败显式标记 PARTIAL", () => {
    let calls = 0;
    const codex = adapter({
      client: "CODEX",
      previousProfiles: ["core", "memory"],
      apply: () => {
        calls += 1;
        if (calls === 2) throw new Error("ROLLBACK_FAILED");
      },
    });

    try {
      runMcpProfileSwitch({
        enabled: false,
        adapters: [codex],
        commit: () => {
          throw new Error("SETTING_VERSION_CONFLICT");
        },
      });
      throw new Error("expected switch failure");
    } catch (error) {
      expect(error).toBeInstanceOf(McpProfileSwitchError);
      expect((error as McpProfileSwitchError).code).toBe("MCP_PROFILE_SWITCH_PARTIAL");
      expect((error as McpProfileSwitchError).report.clients[0]?.status).toBe("ROLLBACK_FAILED");
    }
  });
});
