import { join, resolve } from "node:path";

/** Task Scheduler starts the GUI outside the Agent's Job. Only non-secret
 * path/fixture settings cross that process boundary; no arbitrary environment. */
export function applyLaunchContext(argv: readonly string[], env: NodeJS.ProcessEnv): void {
  const values = argv.filter((arg) => arg.startsWith("--atm-launch-context="));
  if (values.length === 0) return;
  if (values.length !== 1) throw new Error("ATM_LAUNCH_CONTEXT_INVALID");
  const encoded = values[0]!.slice("--atm-launch-context=".length);
  if (encoded.length > 32_768 || !/^[A-Za-z0-9+/]+=*$/u.test(encoded))
    throw new Error("ATM_LAUNCH_CONTEXT_INVALID");
  const input: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("ATM_LAUNCH_CONTEXT_INVALID");
  const allowed = new Set([
    "ATM_DATA_DIR",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ATM_PACKAGED_SMOKE",
    "ATM_SMOKE_AGENT_CONFIG_ROOT",
    "ATM_SMOKE_MCP_CONFIG_REPAIR",
  ]);
  for (const [key, value] of Object.entries(input)) {
    if (
      !allowed.has(key) ||
      typeof value !== "string" ||
      value.length > 4096 ||
      /[\0\r\n]/u.test(value)
    )
      throw new Error("ATM_LAUNCH_CONTEXT_INVALID");
  }
  for (const [key, value] of Object.entries(input)) env[key] = value as string;
  // Preserve the existing production-vs-isolated-data distinction used by
  // automatic integration repair. The default path is not a custom data root.
  if (
    env.ATM_DATA_DIR &&
    env.LOCALAPPDATA &&
    resolve(env.ATM_DATA_DIR).toLowerCase() ===
      resolve(join(env.LOCALAPPDATA, "AyanamiTaskManager")).toLowerCase()
  )
    delete env.ATM_DATA_DIR;
}
