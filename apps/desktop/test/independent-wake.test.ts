import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyLaunchContext } from "../src/launch-context.js";
const bridgePath = join(process.cwd(), "apps/desktop/resources/mcp-stdio.cjs");
const { scheduledWakeScript } = createRequire(bridgePath)(bridgePath) as {
  scheduledWakeScript(exe: string, data: string, env: NodeJS.ProcessEnv): string;
};
const encode = (value: unknown) =>
  `--atm-launch-context=${Buffer.from(JSON.stringify(value)).toString("base64")}`;

describe("independent desktop wake", () => {
  it("registers only a current-user on-demand task with no time or battery stop", () => {
    const script = scheduledWakeScript("C:\\ATM's folder\\AyanamiTaskManager.exe", "C:/data", {
      LOCALAPPDATA: "C:/local",
      ATM_TOKEN: "never-export",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(script).toContain("$definition.Principal.RunLevel=0");
    expect(script).toContain("$definition.Principal.LogonType=3");
    expect(script).toContain("$definition.Settings.ExecutionTimeLimit='PT0S'");
    expect(script).toContain("$definition.Settings.StopIfGoingOnBatteries=$false");
    expect(script).toContain("ATM''s folder");
    expect(script).not.toContain("Triggers.Create");
    expect(script).not.toContain("never-export");
    const arg = script.match(/--atm-launch-context=([A-Za-z0-9+/=]+)/u)![0];
    const env: NodeJS.ProcessEnv = {};
    applyLaunchContext([arg], env);
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ATM_TOKEN).toBeUndefined();
    expect(env.LOCALAPPDATA).toBe("C:/local");
  });
  it("validates the complete context before changing environment", () => {
    const env = { LOCALAPPDATA: "original" };
    expect(() =>
      applyLaunchContext(
        [encode({ LOCALAPPDATA: "changed", NODE_OPTIONS: "--require evil" })],
        env,
      ),
    ).toThrow();
    expect(env.LOCALAPPDATA).toBe("original");
    for (const value of [[], null, { HOME: 23 }, { HOME: "x\nline" }])
      expect(() => applyLaunchContext([encode(value)], {})).toThrow();
    expect(() => applyLaunchContext([encode({}), encode({})], {})).toThrow();
  });
  it("preserves default data-root repair and custom smoke isolation", () => {
    const env: NodeJS.ProcessEnv = {};
    applyLaunchContext(
      [encode({ LOCALAPPDATA: "C:/local", ATM_DATA_DIR: "C:/local/AyanamiTaskManager" })],
      env,
    );
    expect(env.ATM_DATA_DIR).toBeUndefined();
    applyLaunchContext([encode({ ATM_DATA_DIR: "C:/isolated", ATM_PACKAGED_SMOKE: "1" })], env);
    expect(env.ATM_DATA_DIR).toBe("C:/isolated");
  });
  it("carries smoke settings only for an explicitly isolated smoke launch", () => {
    const script = scheduledWakeScript("C:/ATM/AyanamiTaskManager.exe", "C:/isolated", {
      ATM_PACKAGED_SMOKE: "1",
      ATM_SMOKE_AGENT_CONFIG_ROOT: "C:/test",
      ATM_WAKE_USER_DATA_DIR: "C:/test profile",
    });
    expect(script).toContain('--user-data-dir="');
    const env: NodeJS.ProcessEnv = {};
    applyLaunchContext([script.match(/--atm-launch-context=([A-Za-z0-9+/=]+)/u)![0]], env);
    expect(env.ATM_PACKAGED_SMOKE).toBe("1");
    expect(env.ATM_SMOKE_AGENT_CONFIG_ROOT).toBe("C:/test");
  });
});
