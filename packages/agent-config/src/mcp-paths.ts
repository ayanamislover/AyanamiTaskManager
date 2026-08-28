import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CLAUDE_DESKTOP_CONFIG = "claude_desktop_config.json";

export function defaultCodexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

/**
 * 返回 Claude Desktop 经典安装和 MSIX 容器中实际可用的配置候选。
 * 只有父目录已经存在的候选才会被返回；全新安装时回退到经典路径。
 */
export function claudeDesktopConfigPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const classic = join(
    env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    "Claude",
    CLAUDE_DESKTOP_CONFIG,
  );
  const packagesRoot = join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Packages");
  const packaged = (existsSync(packagesRoot) ? readdirSync(packagesRoot) : [])
    .filter((name) => name.startsWith("Claude_"))
    .map((name) =>
      join(packagesRoot, name, "LocalCache", "Roaming", "Claude", CLAUDE_DESKTOP_CONFIG),
    )
    .sort();
  const live = [...packaged, classic].filter((path) => existsSync(dirname(path)));
  return live.length > 0 ? live : [classic];
}

export function defaultClaudeConfigPath(): string {
  return claudeDesktopConfigPaths()[0]!;
}

export function defaultClaudeCodeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

const claudeCodeCliCandidates = [
  join(homedir(), ".local", "bin", "claude.exe"),
  join(homedir(), ".local", "bin", "claude"),
  join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "claude.cmd"),
  join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "claude"),
];

/** 找不到 CLI 时返回 null，由调用方决定如何报告；不会回退到直接改写 ~/.claude.json。 */
export function findClaudeCodeCli(): string | null {
  for (const candidate of claudeCodeCliCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `claude${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function defaultCodexSkillsPath(): string {
  return join(homedir(), ".codex", "skills");
}

export function defaultClaudeSkillsPath(): string {
  return join(homedir(), ".claude", "skills");
}

export function defaultCodexRulePath(): string {
  return join(homedir(), ".codex", "AGENTS.md");
}

export function defaultClaudeRulePath(): string {
  return join(homedir(), ".claude", "CLAUDE.md");
}
