import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { backupName } from "./atomic-files.js";
import {
  ATM_SKILL_NAMES,
  ATM_SKILL_RESOURCE_DIRECTORIES,
  type AgentIntegrationState,
} from "./contracts.js";

/**
 * 安装基线：每次由 ATM 写入 Skill 时记下它当时的指纹。
 *
 * 放在 targetRoot 根下而不是各个 Skill 目录里，是因为 directoryFingerprint 按 Skill 目录算，
 * 放进去会把基线自己算进指纹，从此再也对不上。
 */
const SKILL_INSTALL_BASELINE = ".atm-skills.json";

function readInstallBaseline(targetRoot: string): Record<string, string> {
  const path = join(targetRoot, SKILL_INSTALL_BASELINE);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    // 认不出来就当没有基线：结果是不自动覆盖，偏保守的那一边。
    return {};
  }
}

function writeInstallBaseline(targetRoot: string, entries: Record<string, string>): void {
  try {
    writeFileSync(join(targetRoot, SKILL_INSTALL_BASELINE), JSON.stringify(entries), "utf8");
  } catch {
    // 写不进去只会让下次不自动更新，用户仍可在设置里手动装；不该因此让安装失败。
  }
}

export function installAgentSkills(input: {
  sourceRoot: string;
  targetRoot: string;
  /** 只装这几个；不传就是全装。补缺时用得上——用户自己改过的那几个不该被覆盖。 */
  names?: readonly string[];
}): {
  skills: string[];
  paths: string[];
  backupPaths: string[];
} {
  const wanted = input.names ?? [...ATM_SKILL_NAMES, ...ATM_SKILL_RESOURCE_DIRECTORIES];
  if (wanted.length === 0) return { skills: [], paths: [], backupPaths: [] };
  mkdirSync(input.targetRoot, { recursive: true });
  const paths: string[] = [];
  const backupPaths: string[] = [];
  for (const name of wanted) {
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
  // 记下这次装进去的是什么样子。以后版本变了要不要自动覆盖，看的是「和这份基线还一样吗」，
  // 而不是「版本号对不对得上」——版本号说不出用户有没有动过它。
  writeInstallBaseline(input.targetRoot, {
    ...readInstallBaseline(input.targetRoot),
    ...Object.fromEntries(
      wanted.flatMap((name) => {
        const fingerprint = directoryFingerprint(join(input.targetRoot, name));
        return fingerprint === null ? [] : [[name, fingerprint] as const];
      }),
    ),
  });
  return {
    skills: ATM_SKILL_NAMES.filter((name) => wanted.includes(name)),
    paths,
    backupPaths,
  };
}

/**
 * 该自动补齐哪几个 Skill。启动时无人值守地跑，所以判据要比交互式安装严。
 *
 * 装过一次之后就再也不校正，是 atm-knowledge 那次的成因：它是后加的，已经接入的客户端
 * 里一直显示未安装，要用户自己想起来点一次「安装」。缺的归 ATM 补。
 *
 * 但「版本号不同」不是「这份没被用户改过」的凭据：用户改了旧版本的 atm-plan，版本一比
 * 就是 NEEDS_UPDATE，启动时正文被换成发行版。所以自动更新还要求指纹和安装基线一致——
 * 也就是「这份确实是 ATM 上次写进去的那个样子」。对不上（含没有基线的老安装）就留着，
 * 由用户在设置里自己决定；有备份可恢复不等于可以擅自改生效规则。
 */
export function agentSkillsToRepair(input: { sourceRoot: string; targetRoot: string }): string[] {
  const report = inspectAgentSkills(input);
  const names = report.skills
    .filter(
      (skill) =>
        skill.state === "NOT_INSTALLED" ||
        (skill.state === "NEEDS_UPDATE" && skill.matchesInstallBaseline),
    )
    .map((skill) => skill.name);
  // 共享资源缺了就单独补。以前它挂在 atm-plan 名下判断，于是「_shared 不在」会把
  // 用户改过的 atm-plan 一起标成缺失并覆盖掉；而且没有别的 Skill 要补时它自己也补不上。
  for (const shared of ATM_SKILL_RESOURCE_DIRECTORIES) {
    if (!existsSync(join(input.targetRoot, shared))) names.push(shared);
  }
  return names;
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
  skills: Array<{
    name: string;
    state: AgentIntegrationState;
    version: number | null;
    /** 指纹仍与 ATM 上次写入时一致，也就是这份内容没被改过。自动覆盖只认这个。 */
    matchesInstallBaseline: boolean;
  }>;
} {
  const baseline = readInstallBaseline(input.targetRoot);
  const skills = ATM_SKILL_NAMES.map((name) => {
    const source = join(input.sourceRoot, name);
    const target = join(input.targetRoot, name);
    if (!existsSync(target)) {
      return {
        name,
        state: "NOT_INSTALLED" as const,
        version: null,
        matchesInstallBaseline: false,
      };
    }
    const targetFingerprint = directoryFingerprint(target);
    const matchesInstallBaseline =
      targetFingerprint !== null && baseline[name] === targetFingerprint;
    const sourceVersion = skillVersion(source);
    const targetVersion = skillVersion(target);
    if (sourceVersion !== targetVersion) {
      return {
        name,
        state: "NEEDS_UPDATE" as const,
        version: targetVersion,
        matchesInstallBaseline,
      };
    }
    return {
      name,
      state:
        directoryFingerprint(source) === targetFingerprint
          ? ("INSTALLED" as const)
          : ("MODIFIED" as const),
      version: targetVersion,
      matchesInstallBaseline,
    };
  });
  const sharedSource = join(input.sourceRoot, "_shared");
  const sharedTarget = join(input.targetRoot, "_shared");
  const sharedState: AgentIntegrationState = !existsSync(sharedTarget)
    ? "NOT_INSTALLED"
    : directoryFingerprint(sharedSource) === directoryFingerprint(sharedTarget)
      ? "INSTALLED"
      : "MODIFIED";
  // 共享资源的状态汇总进总状态，但不再改写 atm-plan 自己的状态：_shared 不在时把
  // atm-plan 说成「未安装」，等于让一个用户改过的 Skill 变得可以被自动覆盖。
  const states: AgentIntegrationState[] = [...skills.map((skill) => skill.state), sharedState];
  const state = states.includes("MODIFIED")
    ? "MODIFIED"
    : states.includes("NEEDS_UPDATE")
      ? "NEEDS_UPDATE"
      : states.every((each) => each === "INSTALLED")
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
  // 基线是 ATM 自己写进用户目录的文件，卸载要一并带走。留着不会导致误判——目标目录不在
  // 就是 NOT_INSTALLED——但「卸载完还剩一个 ATM 的文件」不像卸载干净。
  rmSync(join(targetRoot, SKILL_INSTALL_BASELINE), { force: true });
  return { backupPaths };
}
