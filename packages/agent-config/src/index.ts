import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AGENT_RULE_SNIPPET =
  "执行项目前先访问 ATM 工具，并阅读 %LOCALAPPDATA%\\AyanamiTaskManager\\ATM_AGENT_GUIDE.md；后续所有任务执行均依赖 ATM。受管开发任务开始实现前必须按可交付结果和可验证验收拆分成可独立验收的工作项。";

export type McpRuntime = {
  endpoint: string;
  token: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
export type McpClient = "CODEX" | "CLAUDE" | "CLAUDE_CODE";
export type InstallResult = { client: McpClient; path: string; backupPath: string | null };
export const ATM_SKILL_NAMES = ["atm-plan", "atm-task"] as const;
const ATM_SKILL_RESOURCE_DIRECTORIES = ["_shared"] as const;
export const ATM_INTEGRATION_VERSION = 1;
export type AgentIntegrationState = "NOT_INSTALLED" | "INSTALLED" | "NEEDS_UPDATE" | "MODIFIED";
export type AgentRuleAction = "PREVIEW" | "INSTALL" | "UPDATE" | "REPAIR" | "UNINSTALL";

const managedRuleBegin = "<!-- AYANAMI_TASK_MANAGER:BEGIN -->";
const managedRuleEnd = "<!-- AYANAMI_TASK_MANAGER:END -->";
const managedRulePayload = `## AyanamiTaskManager

- ATM 是受管开发项目的计划、任务状态、长期记录和 Session 交接事实源。
- 复杂任务形成执行计划后，必须把可独立交付/验证的主要步骤同步为 ATM WorkItem，不能只登记最高层目标。
- 实际执行优先领取 READY 的叶子 WorkItem；Objective / Milestone / EPIC 用于表达目标和范围。
- 开工使用一次 \`atm_begin\` 并直接使用其 brief；不要紧接 \`atm_brief\`。
- 仅在有意义状态变化时写 progress；长期决策/事实/风险写 record。
- 上下文恢复优先 ATM brief / delta，不重新扫描整个项目历史。
- 完整规则见 \`%LOCALAPPDATA%\\AyanamiTaskManager\\ATM_AGENT_GUIDE.md\`。`;

function managedRuleHash(version: number, payload: string): string {
  return createHash("sha256").update(`${version}\n${payload}`).digest("hex");
}

export function renderManagedAgentRule(): string {
  const hash = managedRuleHash(ATM_INTEGRATION_VERSION, managedRulePayload);
  return `${managedRuleBegin}
<!-- ATM-INTEGRATION-VERSION: ${ATM_INTEGRATION_VERSION} -->
<!-- ATM-INTEGRATION-HASH: ${hash} -->

${managedRulePayload}
${managedRuleEnd}`;
}

function managedRuleRange(content: string): { start: number; end: number; block: string } | null {
  const start = content.indexOf(managedRuleBegin);
  const endMarker = content.indexOf(managedRuleEnd, Math.max(0, start));
  if (start < 0 && endMarker < 0) return null;
  if (start < 0 || endMarker < start) {
    return {
      start: Math.max(0, start),
      end: content.length,
      block: content.slice(Math.max(0, start)),
    };
  }
  const end = endMarker + managedRuleEnd.length;
  return { start, end, block: content.slice(start, end) };
}

function contentWithoutManagedRule(content: string): string {
  const range = managedRuleRange(content);
  if (!range) return content;
  const before = content.slice(0, range.start).trimEnd();
  const after = content.slice(range.end).trimStart();
  const remaining = [before, after].filter(Boolean).join("\n\n");
  return remaining ? `${remaining}\n` : "";
}

function contentWithManagedRule(content: string): string {
  const base = contentWithoutManagedRule(content).trimEnd();
  return `${base}${base ? "\n\n" : ""}${renderManagedAgentRule()}\n`;
}

export function inspectManagedAgentRule(path: string): {
  state: AgentIntegrationState;
  path: string;
  version: number | null;
} {
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  const range = managedRuleRange(content);
  if (!range) return { state: "NOT_INSTALLED", path, version: null };
  const versionMatch = /<!-- ATM-INTEGRATION-VERSION: (\d+) -->/u.exec(range.block);
  const hashMatch = /<!-- ATM-INTEGRATION-HASH: ([a-f0-9]{64}) -->/u.exec(range.block);
  const version = versionMatch ? Number(versionMatch[1]) : null;
  const payloadStart = hashMatch ? (hashMatch.index ?? 0) + hashMatch[0].length : -1;
  const payloadEnd = range.block.lastIndexOf(managedRuleEnd);
  const payload = payloadStart >= 0 ? range.block.slice(payloadStart, payloadEnd).trim() : "";
  if (version === null || !hashMatch || hashMatch[1] !== managedRuleHash(version, payload)) {
    return { state: "MODIFIED", path, version };
  }
  if (version !== ATM_INTEGRATION_VERSION) return { state: "NEEDS_UPDATE", path, version };
  return {
    state: range.block === renderManagedAgentRule() ? "INSTALLED" : "MODIFIED",
    path,
    version,
  };
}

export function manageAgentRule(input: { path: string; action: AgentRuleAction }): {
  state: AgentIntegrationState;
  path: string;
  backupPath: string | null;
  current: string;
  proposed: string;
} {
  const current = existsSync(input.path) ? readFileSync(input.path, "utf8") : "";
  const inspected = inspectManagedAgentRule(input.path);
  const proposed =
    input.action === "UNINSTALL"
      ? contentWithoutManagedRule(current)
      : contentWithManagedRule(current);
  if (input.action === "PREVIEW") return { ...inspected, backupPath: null, current, proposed };
  if (inspected.state === "MODIFIED" && input.action !== "REPAIR" && input.action !== "UNINSTALL") {
    throw new Error("AGENT_RULE_MODIFIED_REQUIRES_REPAIR");
  }
  if (input.action === "UPDATE" && inspected.state === "INSTALLED") {
    return { ...inspected, backupPath: null, current, proposed: current };
  }
  if (input.action === "INSTALL" && inspected.state === "NEEDS_UPDATE") {
    throw new Error("AGENT_RULE_NEEDS_EXPLICIT_UPDATE");
  }
  if (current === proposed) return { ...inspected, backupPath: null, current, proposed };
  const backupPath = replaceFileWithBackup(input.path, proposed);
  return {
    ...inspectManagedAgentRule(input.path),
    backupPath,
    current,
    proposed,
  };
}

function backupName(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return `${path}.bak-${stamp}-${randomBytes(3).toString("hex")}`;
}

function replaceFileWithBackup(path: string, content: string): string | null {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (!existsSync(path)) {
    renameSync(temporary, path);
    return null;
  }
  const backupPath = backupName(path);
  renameSync(path, backupPath);
  try {
    renameSync(temporary, path);
    return backupPath;
  } catch (error) {
    if (!existsSync(path) && existsSync(backupPath)) renameSync(backupPath, path);
    throw error;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function withoutOwnCodexSection(content: string): string {
  const output: string[] = [];
  let skipping = false;
  for (const line of content.split(/\r?\n/u)) {
    const header = line.trim().match(/^\[([^\]]+)\]$/u)?.[1];
    if (header) {
      skipping = new Set([
        'mcp_servers."ayanami-task-manager"',
        "mcp_servers.ayanami-task-manager",
      ]).has(header);
      if (skipping) continue;
    }
    if (!skipping) output.push(line);
  }
  return output.join("\n").trimEnd();
}

export function defaultCodexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

export function defaultClaudeConfigPath(): string {
  return join(
    process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    "Claude",
    "claude_desktop_config.json",
  );
}

// Claude Code 不读 claude_desktop_config.json；它的 MCP 注册在 ~/.claude.json。
// 该文件由 Claude Code 自己持有并高频整体重写（含各项目会话状态），ATM 读-改-写
// 会吞掉对方的更新，所以这里只记录路径用于探测，写入一律交给 claude CLI。
export function defaultClaudeCodeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

const claudeCodeCliCandidates = [
  join(homedir(), ".local", "bin", "claude.exe"),
  join(homedir(), ".local", "bin", "claude"),
  join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "claude.cmd"),
  join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "claude"),
];

// 依次查已知安装位置和 PATH。找不到就返回 null，由调用方明确报错——
// 绝不退化成直接改写 ~/.claude.json。
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

export function installAgentSkills(input: { sourceRoot: string; targetRoot: string }): {
  skills: string[];
  paths: string[];
  backupPaths: string[];
} {
  mkdirSync(input.targetRoot, { recursive: true });
  const paths: string[] = [];
  const backupPaths: string[] = [];
  for (const name of [...ATM_SKILL_NAMES, ...ATM_SKILL_RESOURCE_DIRECTORIES]) {
    const source = join(input.sourceRoot, name);
    const target = join(input.targetRoot, name);
    if (!existsSync(source)) throw new Error(`AGENT_SKILL_MISSING: ${name}`);
    if (name !== "_shared" && !existsSync(join(source, "SKILL.md"))) {
      throw new Error(`AGENT_SKILL_MISSING: ${name}`);
    }
    const staging = join(
      input.targetRoot,
      `.${name}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
    );
    cpSync(source, staging, { recursive: true, force: true });
    let backupPath: string | null = null;
    try {
      if (existsSync(target)) {
        backupPath = backupName(target);
        renameSync(target, backupPath);
        backupPaths.push(backupPath);
      }
      renameSync(staging, target);
      paths.push(target);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (backupPath && !existsSync(target) && existsSync(backupPath))
        renameSync(backupPath, target);
      throw error;
    }
  }
  return { skills: [...ATM_SKILL_NAMES], paths, backupPaths };
}

function directoryFingerprint(path: string): string | null {
  if (!existsSync(path)) return null;
  const hash = createHash("sha256");
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = statSync(absolute);
      if (stat.isDirectory()) visit(absolute, relative);
      else {
        hash.update(relative);
        hash.update("\0");
        hash.update(readFileSync(absolute));
        hash.update("\0");
      }
    }
  };
  visit(path, "");
  return hash.digest("hex");
}

function skillVersion(path: string): number | null {
  const manifest = join(path, "SKILL.md");
  if (!existsSync(manifest)) return null;
  const match = /atm-integration-version:\s*(\d+)/u.exec(readFileSync(manifest, "utf8"));
  return match ? Number(match[1]) : null;
}

export function inspectAgentSkills(input: { sourceRoot: string; targetRoot: string }): {
  state: AgentIntegrationState;
  skills: Array<{ name: string; state: AgentIntegrationState; version: number | null }>;
} {
  const skills = ATM_SKILL_NAMES.map((name) => {
    const source = join(input.sourceRoot, name);
    const target = join(input.targetRoot, name);
    if (!existsSync(target)) return { name, state: "NOT_INSTALLED" as const, version: null };
    const sourceVersion = skillVersion(source);
    const targetVersion = skillVersion(target);
    if (sourceVersion !== targetVersion) {
      return { name, state: "NEEDS_UPDATE" as const, version: targetVersion };
    }
    return {
      name,
      state:
        directoryFingerprint(source) === directoryFingerprint(target)
          ? ("INSTALLED" as const)
          : ("MODIFIED" as const),
      version: targetVersion,
    };
  });
  const sharedSource = join(input.sourceRoot, "_shared");
  const sharedTarget = join(input.targetRoot, "_shared");
  const sharedState: AgentIntegrationState = !existsSync(sharedTarget)
    ? "NOT_INSTALLED"
    : directoryFingerprint(sharedSource) === directoryFingerprint(sharedTarget)
      ? "INSTALLED"
      : "MODIFIED";
  if (sharedState !== "INSTALLED") {
    const plan = skills.find((skill) => skill.name === "atm-plan");
    if (plan && plan.state !== "NEEDS_UPDATE") plan.state = sharedState;
  }
  const state = skills.some((skill) => skill.state === "MODIFIED")
    ? "MODIFIED"
    : skills.some((skill) => skill.state === "NEEDS_UPDATE")
      ? "NEEDS_UPDATE"
      : skills.every((skill) => skill.state === "INSTALLED")
        ? "INSTALLED"
        : "NOT_INSTALLED";
  return { state, skills };
}

export function uninstallAgentSkills(targetRoot: string): { backupPaths: string[] } {
  const backupPaths: string[] = [];
  for (const name of [...ATM_SKILL_NAMES, ...ATM_SKILL_RESOURCE_DIRECTORIES]) {
    const target = join(targetRoot, name);
    if (!existsSync(target)) continue;
    const backupPath = backupName(target);
    renameSync(target, backupPath);
    backupPaths.push(backupPath);
  }
  return { backupPaths };
}

export function isCodexConfigInstalled(path = defaultCodexConfigPath()): boolean {
  if (!existsSync(path)) return false;
  return /\[mcp_servers\.(?:"ayanami-task-manager"|ayanami-task-manager)\]/u.test(
    readFileSync(path, "utf8"),
  );
}

export function isClaudeConfigInstalled(path = defaultClaudeConfigPath()): boolean {
  if (!existsSync(path)) return false;
  try {
    const content = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    return Boolean(content.mcpServers?.["ayanami-task-manager"]);
  } catch {
    return false;
  }
}

export function uninstallCodexConfig(path = defaultCodexConfigPath()): InstallResult {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = withoutOwnCodexSection(existing);
  const content = next ? `${next}\n` : "";
  const backupPath = existing === content ? null : replaceFileWithBackup(path, content);
  return { client: "CODEX", path, backupPath };
}

export function uninstallClaudeConfig(path = defaultClaudeConfigPath()): InstallResult {
  if (!existsSync(path)) return { client: "CLAUDE", path, backupPath: null };
  let existing: Record<string, any>;
  try {
    existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    throw new Error("CLAUDE_CONFIG_INVALID_JSON");
  }
  const servers = { ...(existing.mcpServers ?? {}) };
  delete servers["ayanami-task-manager"];
  const content = `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`;
  const backupPath = replaceFileWithBackup(path, content);
  return { client: "CLAUDE", path, backupPath };
}

export function isClaudeCodeConfigInstalled(path = defaultClaudeCodeConfigPath()): boolean {
  return readClaudeCodeServerConfig(path) !== null;
}

function readClaudeCodeServerConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const content = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    const server = content.mcpServers?.["ayanami-task-manager"];
    return server && typeof server === "object" ? (server as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type ClaudeCodeCliRunner = (cli: string, args: string[]) => void;

const runClaudeCodeCli: ClaudeCodeCliRunner = (cli, args) => {
  try {
    const isWindowsCommandShim =
      process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(cli.toLowerCase());
    execFileSync(cli, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: isWindowsCommandShim,
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`CLAUDE_CODE_CLI_FAILED: ${stderr || (error as Error).message}`);
  }
};

function claudeCodeCli(input: { cliPath?: string; findCli?: () => string | null }): string {
  const cli = input.cliPath ?? (input.findCli ?? findClaudeCodeCli)();
  if (!cli) throw new Error("CLAUDE_CODE_CLI_NOT_FOUND");
  return cli;
}

export function installClaudeCodeConfig(input: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cliPath?: string;
  findCli?: () => string | null;
  configPath?: string;
  runCli?: ClaudeCodeCliRunner;
}): InstallResult {
  const cli = claudeCodeCli(input);
  const run = input.runCli ?? runClaudeCodeCli;
  const path = input.configPath ?? defaultClaudeCodeConfigPath();
  const previous = readClaudeCodeServerConfig(path);
  let removed = false;
  // add-json 遇到同名 server 会失败，先移除保证可重复安装；未安装时的移除失败要忽略。
  if (previous) {
    try {
      run(cli, ["mcp", "remove", "ayanami-task-manager", "--scope", "user"]);
      removed = true;
    } catch {
      /* 已不存在或 CLI 拒绝移除时继续尝试安装，由 add 的失败来报错 */
    }
  }
  try {
    run(cli, [
      "mcp",
      "add-json",
      "ayanami-task-manager",
      JSON.stringify({
        command: input.command,
        args: input.args ?? ["--mcp-stdio"],
        ...(input.env ? { env: input.env } : {}),
      }),
      "--scope",
      "user",
    ]);
  } catch (error) {
    if (removed && previous) {
      try {
        run(cli, [
          "mcp",
          "add-json",
          "ayanami-task-manager",
          JSON.stringify(previous),
          "--scope",
          "user",
        ]);
      } catch (rollbackError) {
        throw new Error(
          `CLAUDE_CODE_INSTALL_AND_ROLLBACK_FAILED: ${error instanceof Error ? error.message : String(error)}; rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
  return { client: "CLAUDE_CODE", path, backupPath: null };
}

export function uninstallClaudeCodeConfig(
  input: {
    cliPath?: string;
    findCli?: () => string | null;
    configPath?: string;
    runCli?: ClaudeCodeCliRunner;
  } = {},
): InstallResult {
  const path = input.configPath ?? defaultClaudeCodeConfigPath();
  if (!isClaudeCodeConfigInstalled(path)) return { client: "CLAUDE_CODE", path, backupPath: null };
  const cli = claudeCodeCli(input);
  (input.runCli ?? runClaudeCodeCli)(cli, [
    "mcp",
    "remove",
    "ayanami-task-manager",
    "--scope",
    "user",
  ]);
  return { client: "CLAUDE_CODE", path, backupPath: null };
}

export function installCodexConfig(input: {
  path?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): InstallResult {
  const path = input.path ?? defaultCodexConfigPath();
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const base = withoutOwnCodexSection(existing);
  const own = [
    '[mcp_servers."ayanami-task-manager"]',
    `command = ${tomlString(input.command)}`,
    `args = [${(input.args ?? ["--mcp-stdio"]).map(tomlString).join(", ")}]`,
    ...(input.env && Object.keys(input.env).length > 0
      ? [
          `env = { ${Object.entries(input.env)
            .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
            .join(", ")} }`,
        ]
      : []),
  ].join("\n");
  const backupPath = replaceFileWithBackup(path, `${base}${base ? "\n\n" : ""}${own}\n`);
  return { client: "CODEX", path, backupPath };
}

export function installClaudeConfig(input: {
  path?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): InstallResult {
  const path = input.path ?? defaultClaudeConfigPath();
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error("CLAUDE_CONFIG_INVALID_JSON");
    }
  }
  const currentServers =
    existing.mcpServers && typeof existing.mcpServers === "object"
      ? (existing.mcpServers as Record<string, unknown>)
      : {};
  const merged = {
    ...existing,
    mcpServers: {
      ...currentServers,
      "ayanami-task-manager": {
        command: input.command,
        args: input.args ?? ["--mcp-stdio"],
        ...(input.env ? { env: input.env } : {}),
      },
    },
  };
  const backupPath = replaceFileWithBackup(path, `${JSON.stringify(merged, null, 2)}\n`);
  return { client: "CLAUDE", path, backupPath };
}

export function renderMcpConfigs(runtime: McpRuntime): {
  streamableHttp: string;
  stdio: string;
  generic: string;
  agentRule: string;
} {
  const httpServer = {
    type: "streamable-http",
    url: `${runtime.endpoint.replace(/\/$/u, "")}/mcp`,
    headers: { Authorization: `Bearer ${runtime.token}` },
  };
  const stdioServer = {
    command: runtime.command,
    args: runtime.args ?? ["--mcp-stdio"],
    ...(runtime.env ? { env: runtime.env } : {}),
  };
  return {
    streamableHttp: `${JSON.stringify({ mcpServers: { "ayanami-task-manager": httpServer } }, null, 2)}\n`,
    stdio: `${JSON.stringify({ mcpServers: { "ayanami-task-manager": stdioServer } }, null, 2)}\n`,
    generic: `${JSON.stringify({ mcpServers: { "ayanami-task-manager": httpServer } }, null, 2)}\n`,
    agentRule: AGENT_RULE_SNIPPET,
  };
}
