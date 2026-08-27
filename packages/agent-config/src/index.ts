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
import { basename, dirname, join } from "node:path";

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
export type McpProfile = "core" | "memory" | "actions";
export const MCP_SERVER_NAMES = {
  legacy: "ayanami-task-manager",
  core: "ayanami-task-manager-core",
  memory: "ayanami-task-manager-memory",
  actions: "ayanami-task-manager-actions",
} as const;
const managedMcpServerNames = Object.values(MCP_SERVER_NAMES);

function isManagedMcpServerName(name: string): boolean {
  return managedMcpServerNames.some((managed) => managed === name);
}
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

export const BACKUP_RETENTION = 5;

/**
 * 备份原本只在用户手动点安装时产生，攒得慢。改成每次启动核对、版本变了就重写之后，
 * 每发一版就给三个客户端各留一份——一年下来几百个文件躺在 ~/.codex 和 %APPDATA%\Claude
 * 里，而有价值的只有最近那几份。实测在加这条之前 ~/.codex 已经攒了 34 个。
 *
 * 只删自己这个文件的备份（按 `<basename>.bak-` 前缀），别人的东西一律不碰。
 * 名字里的时间戳是 ISO 的，所以按名字倒序就是按时间倒序。
 */
function pruneBackups(path: string, keep = BACKUP_RETENTION): string[] {
  const directory = dirname(path);
  const prefix = `${basename(path)}.bak-`;
  const stale = readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse()
    .slice(keep);
  for (const name of stale) rmSync(join(directory, name), { force: true });
  return stale;
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
  } catch (error) {
    if (!existsSync(path) && existsSync(backupPath)) renameSync(backupPath, path);
    throw error;
  }
  // 只在新文件已经就位之后才清旧备份：清理失败不该让一次成功的写入变成失败。
  try {
    pruneBackups(path);
  } catch {
    /* 备份清理是卫生问题，不是正确性问题 */
  }
  return backupPath;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

type McpInstallInput = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

function profileArgs(args: string[] | undefined, profile: McpProfile): string[] {
  const source = [...(args ?? ["--mcp-stdio"])];
  const marker = source.indexOf("--profile");
  if (marker >= 0) source.splice(marker, Math.min(2, source.length - marker));
  return [...source, "--profile", profile];
}

function profileLaunch(input: McpInstallInput, profile: McpProfile): McpInstallInput {
  return {
    command: input.command,
    args: profileArgs(input.args, profile),
    ...(input.env ? { env: input.env } : {}),
  };
}

/** 默认提供完整工具面；用户可以显式传 ["core"] 进入低内存降级模式。 */
export const DEFAULT_MCP_PROFILES: readonly McpProfile[] = ["core", "memory", "actions"];

const ALL_MCP_PROFILES: readonly McpProfile[] = ["core", "memory", "actions"];

/**
 * 把请求的 profile 集合归一成稳定顺序的启用集合。
 *
 * core 不可关闭：关掉它就没有任何任务工具面了，ATM 等于没接入。传进来的集合里没有 core
 * 只可能是调用方漏了，不是用户想要一个空的 ATM，所以这里补上而不是照做。
 */
export function enabledMcpProfiles(profiles?: readonly McpProfile[]): McpProfile[] {
  const requested = new Set<McpProfile>(profiles ?? DEFAULT_MCP_PROFILES);
  requested.add("core");
  return ALL_MCP_PROFILES.filter((profile) => requested.has(profile));
}

function isManagedCodexSection(header: string): boolean {
  return managedMcpServerNames.some((name) =>
    [`mcp_servers.${name}`, `mcp_servers.${JSON.stringify(name)}`].some(
      (root) => header === root || header.startsWith(`${root}.`),
    ),
  );
}

function withoutOwnCodexSection(content: string): string {
  const output: string[] = [];
  let skipping = false;
  for (const line of content.split(/\r?\n/u)) {
    const header = line.trim().match(/^\[([^\]]+)\]$/u)?.[1];
    if (header) {
      skipping = isManagedCodexSection(header);
      if (skipping) continue;
    }
    if (!skipping) output.push(line);
  }
  return output.join("\n").trimEnd();
}

export function defaultCodexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

const CLAUDE_DESKTOP_CONFIG = "claude_desktop_config.json";

/**
 * Claude 桌面版有两种安装形态，配置落在两个完全不同的地方。
 *
 * Microsoft Store（MSIX）装的那份带包身份，写 `%APPDATA%` 会被系统重定向进包容器：
 *
 *   %LOCALAPPDATA%\Packages\Claude_<publisherId>\LocalCache\Roaming\Claude\claude_desktop_config.json
 *
 * 而本模块从 `process.env.APPDATA` 拼出来的是 `%APPDATA%\Claude\...`——那个路径上
 * 可能确实存在一个同名文件（旧的非 Store 安装留下的），于是写进去、读回来、一切
 * 正常，唯独应用永远看不到。实测连续三轮「已修复」都写进了这个幽灵文件，用户那边
 * 的 MCP 一直指着几个版本之前的 exe。
 *
 * 所以路径不能只给一个。返回所有**父目录已经存在**的候选：目录都不存在就说明那种
 * 形态没装，凭空建一个只会再造一个幽灵。一个都不存在时退回经典路径，好让全新安装
 * 仍然装得上。
 */
export function claudeDesktopConfigPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const classic = join(
    env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    "Claude",
    CLAUDE_DESKTOP_CONFIG,
  );
  const packagesRoot = join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Packages");
  // 包名里的 publisherId 是按发布者证书算出来的哈希，不能写死。
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

/**
 * 「已安装」= 配置里出现的受管 server **恰好**等于启用集合。
 *
 * 不能只查「启用的都在」：用户关掉 memory 之后，那样会一直报已安装，界面上再没有任何
 * 入口去掉多余的那个 server，开关看着就是失灵的。legacy 也走这条——它永远不在启用集合里。
 */
function installedProfileSetMatches(
  installed: InstalledMcpProfileLaunches,
  profiles?: readonly McpProfile[],
): boolean {
  const enabled = new Set(enabledMcpProfiles(profiles));
  return (
    installed.legacy === null &&
    (installed.core !== null) === enabled.has("core") &&
    (installed.memory !== null) === enabled.has("memory") &&
    (installed.actions !== null) === enabled.has("actions")
  );
}

export function isCodexConfigInstalled(
  path = defaultCodexConfigPath(),
  profiles?: readonly McpProfile[],
): boolean {
  return installedProfileSetMatches(installedCodexProfileLaunches(path), profiles);
}

export function isClaudeConfigInstalled(path?: string, profiles?: readonly McpProfile[]): boolean {
  if (path === undefined)
    return claudeDesktopConfigPaths().some((each) => isClaudeConfigInstalled(each, profiles));
  return installedProfileSetMatches(installedClaudeProfileLaunches(path), profiles);
}

export function uninstallCodexConfig(path = defaultCodexConfigPath()): InstallResult {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = withoutOwnCodexSection(existing);
  const content = next ? `${next}\n` : "";
  const backupPath = existing === content ? null : replaceFileWithBackup(path, content);
  return { client: "CODEX", path, backupPath };
}

export function uninstallClaudeConfig(path?: string): InstallResult {
  if (path === undefined) {
    // 只留一处没清等于没卸载：应用读哪一份由安装形态决定，不是我们能挑的。
    const results = claudeDesktopConfigPaths().map((each) => uninstallClaudeConfig(each));
    return results.find((result) => result.backupPath !== null) ?? results[0]!;
  }
  if (!existsSync(path)) return { client: "CLAUDE", path, backupPath: null };
  let existing: Record<string, any>;
  try {
    existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    throw new Error("CLAUDE_CONFIG_INVALID_JSON");
  }
  const servers = { ...(existing.mcpServers ?? {}) };
  for (const name of managedMcpServerNames) delete servers[name];
  const content = `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`;
  const current = readFileSync(path, "utf8");
  const backupPath = current === content ? null : replaceFileWithBackup(path, content);
  return { client: "CLAUDE", path, backupPath };
}

export function isClaudeCodeConfigInstalled(
  path = defaultClaudeCodeConfigPath(),
  profiles?: readonly McpProfile[],
): boolean {
  const servers = readJsonMcpServers(path);
  const enabled = new Set<string>(
    enabledMcpProfiles(profiles).map((profile) => MCP_SERVER_NAMES[profile]),
  );
  return managedMcpServerNames.every((name) => Boolean(servers?.[name]) === enabled.has(name));
}

function readJsonMcpServers(path: string): Record<string, Record<string, unknown>> | null {
  if (!existsSync(path)) return null;
  try {
    const content = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    if (!content.mcpServers || typeof content.mcpServers !== "object") return {};
    return Object.fromEntries(
      Object.entries(content.mcpServers as Record<string, unknown>).filter(
        (entry): entry is [string, Record<string, unknown>] =>
          Boolean(entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1])),
      ),
    );
  } catch {
    return null;
  }
}

function readClaudeCodeManagedConfigs(path: string): Record<string, Record<string, unknown>> {
  const servers = readJsonMcpServers(path) ?? {};
  return Object.fromEntries(
    Object.entries(servers).filter(([name]) => isManagedMcpServerName(name)),
  );
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every((entry): entry is [string, string] => typeof entry[1] === "string")
    ? Object.fromEntries(entries)
    : null;
}

function serverConfigMatches(
  current: Record<string, unknown> | undefined,
  desired: McpInstallInput,
) {
  if (!current || current.command !== desired.command) return false;
  const currentArgs = Array.isArray(current.args) ? current.args.map(String) : [];
  if (JSON.stringify(currentArgs) !== JSON.stringify(desired.args ?? [])) return false;
  const currentEnv = stringRecord(current.env) ?? {};
  const desiredEnv = desired.env ?? {};
  return (
    JSON.stringify(Object.entries(currentEnv).sort()) ===
    JSON.stringify(Object.entries(desiredEnv).sort())
  );
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
  profiles?: readonly McpProfile[];
}): InstallResult {
  const cli = claudeCodeCli(input);
  const run = input.runCli ?? runClaudeCodeCli;
  const path = input.configPath ?? defaultClaudeCodeConfigPath();
  const previous = readClaudeCodeManagedConfigs(path);
  const desired = Object.fromEntries(
    enabledMcpProfiles(input.profiles).map((profile) => [
      MCP_SERVER_NAMES[profile],
      profileLaunch(input, profile),
    ]),
  );
  // 「已经对了」必须两头都成立：该有的都在且一致，**不该有的一个都不能剩**。
  // 只查前者的话，用户关掉 memory 之后这里会判定无需改动直接返回，已注册的 memory
  // 就永远留在配置里——用户看到的就是「开关关不掉」。legacy 同理，它永远不在 desired 里。
  const unchanged =
    managedMcpServerNames.every(
      (name) => desired[name] !== undefined || previous[name] === undefined,
    ) &&
    Object.entries(desired).every(([name, config]) => serverConfigMatches(previous[name], config));
  if (unchanged) return { client: "CLAUDE_CODE", path, backupPath: null };
  const removed: Array<[string, Record<string, unknown>]> = [];
  const added: string[] = [];
  try {
    for (const name of managedMcpServerNames) {
      const config = previous[name];
      if (!config) continue;
      run(cli, ["mcp", "remove", name, "--scope", "user"]);
      removed.push([name, config]);
    }
    for (const [name, config] of Object.entries(desired)) {
      run(cli, ["mcp", "add-json", name, JSON.stringify(config), "--scope", "user"]);
      added.push(name);
    }
  } catch (error) {
    try {
      for (const name of added.reverse()) {
        run(cli, ["mcp", "remove", name, "--scope", "user"]);
      }
      for (const [name, config] of removed) {
        run(cli, ["mcp", "add-json", name, JSON.stringify(config), "--scope", "user"]);
      }
    } catch (rollbackError) {
      throw new Error(
        `CLAUDE_CODE_INSTALL_AND_ROLLBACK_FAILED: ${error instanceof Error ? error.message : String(error)}; rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error },
      );
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
  const installed = readClaudeCodeManagedConfigs(path);
  if (Object.keys(installed).length === 0) return { client: "CLAUDE_CODE", path, backupPath: null };
  const cli = claudeCodeCli(input);
  for (const name of managedMcpServerNames) {
    if (!installed[name]) continue;
    (input.runCli ?? runClaudeCodeCli)(cli, ["mcp", "remove", name, "--scope", "user"]);
  }
  return { client: "CLAUDE_CODE", path, backupPath: null };
}

export function installCodexConfig(input: {
  path?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  profiles?: readonly McpProfile[];
}): InstallResult {
  const path = input.path ?? defaultCodexConfigPath();
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  // withoutOwnCodexSection 会摘掉 legacy/core/memory 全部受管段落，所以关掉 memory 之后
  // 重写这一次就把它带走了——不需要单独写一条删除逻辑。
  const base = withoutOwnCodexSection(existing);
  const sections = enabledMcpProfiles(input.profiles).map((profile) => {
    const launch = profileLaunch(input, profile);
    return [
      `[mcp_servers.${tomlString(MCP_SERVER_NAMES[profile])}]`,
      `command = ${tomlString(launch.command)}`,
      `args = [${launch.args!.map(tomlString).join(", ")}]`,
      ...(launch.env && Object.keys(launch.env).length > 0
        ? [
            `env = { ${Object.entries(launch.env)
              .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
              .join(", ")} }`,
          ]
        : []),
    ].join("\n");
  });
  const content = `${base}${base ? "\n\n" : ""}${sections.join("\n\n")}\n`;
  const backupPath = existing === content ? null : replaceFileWithBackup(path, content);
  return { client: "CODEX", path, backupPath };
}

export function installClaudeConfig(input: {
  path?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  profiles?: readonly McpProfile[];
}): InstallResult {
  if (input.path === undefined) {
    // 两种安装形态各有一份配置，而「应用读哪一份」由安装形态决定，不是我们能挑的。
    // 只写一份就赌对了一半——赌输的那半是「写进去了、读回来是对的、应用永远看不到」。
    const results = claudeDesktopConfigPaths().map((path) =>
      installClaudeConfig({ ...input, path }),
    );
    return results[0]!;
  }
  const path = input.path;
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
  const preservedServers = Object.fromEntries(
    Object.entries(currentServers).filter(([name]) => !isManagedMcpServerName(name)),
  );
  // preservedServers 已经滤掉全部受管名字，所以这里只写启用的那些，关掉的 memory
  // 就在这一次重写里消失了。
  const managedServers = Object.fromEntries(
    enabledMcpProfiles(input.profiles).map((profile) => {
      const launch = profileLaunch(input, profile);
      return [
        MCP_SERVER_NAMES[profile],
        {
          command: launch.command,
          args: launch.args,
          ...(launch.env ? { env: launch.env } : {}),
        },
      ];
    }),
  );
  const merged = {
    ...existing,
    mcpServers: { ...preservedServers, ...managedServers },
  };
  const content = `${JSON.stringify(merged, null, 2)}\n`;
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const backupPath = current === content ? null : replaceFileWithBackup(path, content);
  return { client: "CLAUDE", path, backupPath };
}

export function renderMcpConfigs(
  runtime: McpRuntime,
  profiles?: readonly McpProfile[],
): {
  streamableHttp: string;
  stdio: string;
  generic: string;
  agentRule: string;
} {
  // 这里渲染的是给用户手动复制的配置文本。它必须和自动安装写出来的一致：
  // 否则用户按界面提示复制一份，就把自己关掉的 memory 又贴了回去。
  const rendered = enabledMcpProfiles(profiles);
  const httpServers = Object.fromEntries(
    rendered.map((profile) => [
      MCP_SERVER_NAMES[profile],
      {
        type: "streamable-http",
        url: `${runtime.endpoint.replace(/\/$/u, "")}/mcp/${profile}`,
        headers: { Authorization: `Bearer ${runtime.token}` },
      },
    ]),
  );
  const stdioServers = Object.fromEntries(
    rendered.map((profile) => {
      const launch = profileLaunch(runtime, profile);
      return [
        MCP_SERVER_NAMES[profile],
        {
          command: launch.command,
          args: launch.args,
          ...(launch.env ? { env: launch.env } : {}),
        },
      ];
    }),
  );
  return {
    streamableHttp: `${JSON.stringify({ mcpServers: httpServers }, null, 2)}\n`,
    stdio: `${JSON.stringify({ mcpServers: stdioServers }, null, 2)}\n`,
    generic: `${JSON.stringify({ mcpServers: httpServers }, null, 2)}\n`,
    agentRule: AGENT_RULE_SNIPPET,
  };
}

export type InstalledMcpLaunch = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};
export type InstalledMcpProfileLaunches = {
  legacy: InstalledMcpLaunch | null;
  core: InstalledMcpLaunch | null;
  memory: InstalledMcpLaunch | null;
  actions: InstalledMcpLaunch | null;
};

function launchFromServerConfig(server: Record<string, unknown> | null): InstalledMcpLaunch | null {
  if (!server || typeof server.command !== "string") return null;
  return {
    command: server.command,
    args: Array.isArray(server.args) ? server.args.map((value) => String(value)) : [],
    env: stringRecord(server.env) ?? {},
  };
}

function tomlInlineStringTable(value: string): Record<string, string> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return {};
  const entries: Array<[string, string]> = [];
  const pattern = /("(?:\\.|[^"\\])*")\s*=\s*("(?:\\.|[^"\\])*")/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(inner)) !== null) {
    entries.push([JSON.parse(match[1]!) as string, JSON.parse(match[2]!) as string]);
  }
  const residue = inner.replace(pattern, "").replaceAll(",", "").trim();
  return residue ? null : Object.fromEntries(entries);
}

function jsonProfileLaunches(path: string): InstalledMcpProfileLaunches {
  const servers = readJsonMcpServers(path) ?? {};
  return {
    legacy: launchFromServerConfig(servers[MCP_SERVER_NAMES.legacy] ?? null),
    core: launchFromServerConfig(servers[MCP_SERVER_NAMES.core] ?? null),
    memory: launchFromServerConfig(servers[MCP_SERVER_NAMES.memory] ?? null),
    actions: launchFromServerConfig(servers[MCP_SERVER_NAMES.actions] ?? null),
  };
}

/**
 * 读出各客户端里 ATM 那一项当前登记的 command/args。
 *
 * 判断「装没装」不够用：配置可以装着、却指向一个已经不存在的路径。1.0.3 的
 * 配置一路留到 1.0.10，isInstalled 全程为真，而 Agent 侧一直连不上。要修就得
 * 先能读出登记的到底是什么。
 */
export function installedClaudeLaunch(path = defaultClaudeConfigPath()): InstalledMcpLaunch | null {
  const launches = installedClaudeProfileLaunches(path);
  return launches.core ?? launches.legacy;
}

export function installedClaudeProfileLaunches(
  path = defaultClaudeConfigPath(),
): InstalledMcpProfileLaunches {
  return jsonProfileLaunches(path);
}

/**
 * 两种安装形态各有一份配置，任何一份过期都要修——修了 A 没修 B，就是「应用读 B 的
 * 那台机器一直坏着，而我们这边看着是绿的」。
 */
export function installedClaudeLaunches(): InstalledMcpLaunch[] {
  return claudeDesktopConfigPaths()
    .map((path) => installedClaudeLaunch(path))
    .filter((launch): launch is InstalledMcpLaunch => launch !== null);
}

export function installedClaudeProfileLaunchSets(): InstalledMcpProfileLaunches[] {
  return claudeDesktopConfigPaths().map((path) => installedClaudeProfileLaunches(path));
}

export function installedClaudeCodeLaunch(
  path = defaultClaudeCodeConfigPath(),
): InstalledMcpLaunch | null {
  const launches = installedClaudeCodeProfileLaunches(path);
  return launches.core ?? launches.legacy;
}

export function installedClaudeCodeProfileLaunches(
  path = defaultClaudeCodeConfigPath(),
): InstalledMcpProfileLaunches {
  return jsonProfileLaunches(path);
}

function codexProfileLaunches(path: string): InstalledMcpProfileLaunches {
  const found: Record<string, InstalledMcpLaunch> = {};
  if (!existsSync(path)) return { legacy: null, core: null, memory: null, actions: null };
  let activeName: string | null = null;
  let command: string | null = null;
  let args: string[] = [];
  let env: Record<string, string> = {};
  const flush = () => {
    if (activeName && command !== null) found[activeName] = { command, args, env };
    command = null;
    args = [];
    env = {};
  };
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const header = line.trim().match(/^\[([^\]]+)\]$/u)?.[1];
    if (header !== undefined) {
      flush();
      const match = /^mcp_servers\.(?:"([^"]+)"|(.+))$/u.exec(header);
      const name = match?.[1] ?? match?.[2] ?? null;
      activeName = name && isManagedMcpServerName(name) ? name : null;
      continue;
    }
    if (!activeName) continue;
    const commandValue = line.trim().match(/^command\s*=\s*(".*")$/u)?.[1];
    if (commandValue) command = JSON.parse(commandValue) as string;
    const argsValue = line.trim().match(/^args\s*=\s*(\[.*\])$/u)?.[1];
    if (argsValue) args = (JSON.parse(argsValue) as unknown[]).map((value) => String(value));
    const envValue = line.trim().match(/^env\s*=\s*(\{.*\})$/u)?.[1];
    if (envValue) env = tomlInlineStringTable(envValue) ?? {};
  }
  flush();
  return {
    legacy: found[MCP_SERVER_NAMES.legacy] ?? null,
    core: found[MCP_SERVER_NAMES.core] ?? null,
    memory: found[MCP_SERVER_NAMES.memory] ?? null,
    actions: found[MCP_SERVER_NAMES.actions] ?? null,
  };
}

export function installedCodexProfileLaunches(
  path = defaultCodexConfigPath(),
): InstalledMcpProfileLaunches {
  return codexProfileLaunches(path);
}

export function installedCodexLaunch(path = defaultCodexConfigPath()): InstalledMcpLaunch | null {
  const launches = installedCodexProfileLaunches(path);
  return launches.core ?? launches.legacy;
}
