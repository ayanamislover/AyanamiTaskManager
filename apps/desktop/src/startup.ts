import { join } from "node:path";

export const STARTUP_DELAY_MIN_MS = 0;
export const STARTUP_DELAY_MAX_MS = 5_000;
export const LOGIN_ITEM_ARGS = ["--background", "--random-startup-delay"] as const;
export const AGENT_WAKE_ARGS = ["--background", "--agent-wake"] as const;

export function isAgentWakeRequest(args: readonly string[]): boolean {
  return AGENT_WAKE_ARGS.every((argument) => args.includes(argument));
}

export function loginItemExecutable(dataDir: string): string {
  return join(dataDir, "current", "AyanamiTaskManager.exe");
}

export function randomStartupDelayMs(random: () => number = Math.random): number {
  const sample = Math.min(0.999_999, Math.max(0, random()));
  return Math.floor(
    STARTUP_DELAY_MIN_MS + sample * (STARTUP_DELAY_MAX_MS - STARTUP_DELAY_MIN_MS + 1),
  );
}

export function shouldDelayStartup(args: string[], smoke: boolean): boolean {
  return !smoke && LOGIN_ITEM_ARGS.every((argument) => args.includes(argument));
}

export function shouldStartInBackground(args: string[], foregroundRequested: boolean): boolean {
  return args.includes("--background") && !foregroundRequested;
}

export function waitForStartupDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}
