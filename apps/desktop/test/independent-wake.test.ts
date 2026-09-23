import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyLaunchContext } from "../src/launch-context.js";
const bridgePath = join(process.cwd(), "apps/desktop/resources/mcp-stdio.cjs");
const { scheduledWakeScript, wakeTaskRemovalScript } = createRequire(bridgePath)(bridgePath) as {
  scheduledWakeScript(exe: string, data: string, env: NodeJS.ProcessEnv): string;
  wakeTaskRemovalScript(data: string): string;
};
const encode = (value: unknown) =>
  `--atm-launch-context=${Buffer.from(JSON.stringify(value)).toString("base64")}`;
/** Value assigned to `$action.<field>`: must be a base64 literal decoded in the script. */
const assigned = (script: string, field: "Path" | "Arguments") => {
  const match = new RegExp(
    `^\\$action\\.${field}=\\[Text\\.Encoding\\]::UTF8\\.GetString\\(\\[Convert\\]::FromBase64String\\('([A-Za-z0-9+/=]*)'\\)\\)$`,
    "mu",
  ).exec(script);
  if (!match) throw new Error(`$action.${field} is not a base64 literal`);
  return Buffer.from(match[1]!, "base64").toString("utf8");
};

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
    // Task Scheduler defaults to priority 7 (below normal) for the whole process tree.
    expect(script).toContain("$definition.Settings.Priority=4");
    expect(assigned(script, "Path")).toBe("C:\\ATM's folder\\AyanamiTaskManager.exe");
    expect(script).not.toContain("Triggers.Create");
    // Arguments are base64 in the script, so check the decoded text, not the script.
    const args = assigned(script, "Arguments");
    expect(args).not.toContain("never-export");
    const arg = args.match(/--atm-launch-context=([A-Za-z0-9+/=]+)/u)![0];
    expect(Buffer.from(arg.split("=").slice(1).join("="), "base64").toString("utf8")).not.toContain(
      "never-export",
    );
    const env: NodeJS.ProcessEnv = {};
    applyLaunchContext([arg], env);
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ATM_TOKEN).toBeUndefined();
    expect(env.LOCALAPPDATA).toBe("C:/local");
  });
  it("carries any path text verbatim, including quotes PowerShell treats as delimiters", () => {
    // U+2018..U+201B also close a PowerShell single-quoted string; so do ASCII quotes.
    const exe = "C:\\Users\\O\u2019Brien \u2018x\u201A\u201B'\"$(x);`n\\AyanamiTaskManager.exe";
    const profile = "C:\\smoke \u2019profile";
    const script = scheduledWakeScript(exe, "C:/data", {
      ATM_PACKAGED_SMOKE: "1",
      ATM_WAKE_USER_DATA_DIR: profile,
    });
    expect(assigned(script, "Path")).toBe(exe);
    expect(assigned(script, "Arguments")).toContain(`--user-data-dir="${profile}"`);
    // No raw path text reaches the script body, so nothing in it can end a string.
    for (const quote of ["\u2018", "\u2019", "\u201A", "\u201B"])
      expect(script).not.toContain(quote);
    expect(script).not.toContain("O\u2019Brien");
  });
  it("registration and uninstall address the same per-data-root task", () => {
    const nameLine = (script: string) =>
      script.split("\n").find((line) => line.startsWith("$name="));
    expect(nameLine(wakeTaskRemovalScript("C:/Data"))).toBe(
      nameLine(scheduledWakeScript("C:/ATM/AyanamiTaskManager.exe", "c:/data", {})),
    );
    expect(nameLine(wakeTaskRemovalScript("C:/other"))).not.toBe(
      nameLine(wakeTaskRemovalScript("C:/data")),
    );
    const removal = wakeTaskRemovalScript("C:/data");
    expect(removal).toContain("$root.DeleteTask($name,0)");
    // Deleting the definition must not stop a running ATM instance.
    expect(removal).not.toMatch(/\.Stop\(/u);
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
    const args = assigned(script, "Arguments");
    expect(args).toContain('--user-data-dir="');
    const env: NodeJS.ProcessEnv = {};
    applyLaunchContext([args.match(/--atm-launch-context=([A-Za-z0-9+/=]+)/u)![0]], env);
    expect(env.ATM_PACKAGED_SMOKE).toBe("1");
    expect(env.ATM_SMOKE_AGENT_CONFIG_ROOT).toBe("C:/test");
  });
});
