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
} from "node:fs";
import { join } from "node:path";
import { backupName } from "./atomic-files.js";
import {
  ATM_SKILL_NAMES,
  ATM_SKILL_RESOURCE_DIRECTORIES,
  type AgentIntegrationState,
} from "./contracts.js";

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
