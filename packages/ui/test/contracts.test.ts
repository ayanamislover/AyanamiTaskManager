import { describe, expect, it } from "vitest";
import type {
  AgentIntegrationReport,
  AyanamiTaskManagerProps,
  DesktopBridge,
  McpBridgeObservation,
  McpClient,
  Theme,
} from "../src/contracts.js";
import type { McpBridgeObservation as PanelObservation } from "../src/mcp-bridge-panel.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const contractParity: [
  Expect<Equal<McpBridgeObservation, PanelObservation>>,
  Expect<Equal<Theme, "light" | "dark">>,
  Expect<Equal<McpClient, "CODEX" | "CLAUDE" | "CLAUDE_CODE">>,
  Expect<Equal<DesktopBridge, Partial<Required<DesktopBridge>>>>,
] = [true, true, true, true];

describe("UI contracts", () => {
  it("保留可选 Desktop bridge 与组件 props 的结构契约", () => {
    const desktop = {} satisfies DesktopBridge;
    const props = {
      client: {} as AyanamiTaskManagerProps["client"],
    } satisfies AyanamiTaskManagerProps;
    expect(desktop).toEqual({});
    expect(Object.keys(props)).toEqual(["client"]);
    expect(contractParity).toEqual([true, true, true, true]);
  });

  it("保留 Agent integration report 的嵌套状态形状", () => {
    const report: AgentIntegrationReport = {
      client: "CODEX",
      mcpInstalled: true,
      repairError: null,
      sharesRuleAndSkillsWith: null,
      cliAvailable: true,
      rule: { state: "INSTALLED", path: "C:\\agent.md", version: 1 },
      skills: { state: "INSTALLED", skills: [] },
    };
    expect(report.rule.state).toBe("INSTALLED");
  });
});
