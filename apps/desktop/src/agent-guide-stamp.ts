/**
 * 安装到 %LOCALAPPDATA% 的 ATM_AGENT_GUIDE.md 要能自证是哪一版（ATM-T-0412）。
 *
 * 以前两个 Agent 会话各自去比对几份 guide 副本的字节数和 mtime，才确认本机那份是旧构建。
 * 戳只盖在打包产物里的副本上：源仓那份不带戳，也就不会有每次构建都变的脏 diff。
 * 打包、打包校验和 smoke 共用这一个函数，三处对「盖了戳的 guide 长什么样」只有一种答案。
 */

const STAMP_PREFIX = "> 构建版本：";
const STAMP_PATTERN = /^> 构建版本：`([^`]+)` · commit `([0-9a-f]{7,40}(?:-dirty)?)`。/mu;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}(?:-dirty)?$/u;

export type AgentGuideBuild = Readonly<{ version: string; commit: string }>;

export function agentGuideStampLine(build: AgentGuideBuild): string {
  if (!VERSION_PATTERN.test(build.version)) {
    throw new Error(`AGENT_GUIDE_STAMP_VERSION_INVALID: ${build.version}`);
  }
  if (!COMMIT_PATTERN.test(build.commit)) {
    throw new Error(`AGENT_GUIDE_STAMP_COMMIT_INVALID: ${build.commit}`);
  }
  return `${STAMP_PREFIX}\`${build.version}\` · commit \`${build.commit}\`。本行由打包流程写入，源仓副本没有这一行；与 \`runtime\\daemon.json\` 的 \`version\` 不一致时，说明手里这份 guide 已过期。`;
}

/** 在一级标题下插入构建戳。源文件缺标题或已带戳都视为流程错误，不静默跳过。 */
export function stampAgentGuide(content: string, build: AgentGuideBuild): string {
  if (readAgentGuideBuild(content) !== null) throw new Error("AGENT_GUIDE_ALREADY_STAMPED");
  // 打包取的是工作区文件，换行符随 checkout 设置而定；戳跟着原文走，不混用。
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const newline = content.indexOf(eol);
  const title = newline === -1 ? content : content.slice(0, newline);
  if (!title.startsWith("# ")) throw new Error("AGENT_GUIDE_TITLE_MISSING");
  const rest = newline === -1 ? "" : content.slice(newline + eol.length);
  const gap = rest.startsWith(eol) ? "" : eol;
  return `${title}${eol}${eol}${agentGuideStampLine(build)}${eol}${gap}${rest}`;
}

export function readAgentGuideBuild(content: string): AgentGuideBuild | null {
  const match = STAMP_PATTERN.exec(content);
  return match ? { version: match[1]!, commit: match[2]! } : null;
}
