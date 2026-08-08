import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const AGENT_GUIDE_FILENAME = "ATM_AGENT_GUIDE.md";

export function installAgentDocumentation(
  bundledRoot: string,
  dataDir: string,
): { guidePath: string; docsPath: string; skillsPath: string } {
  const bundledGuide = join(bundledRoot, AGENT_GUIDE_FILENAME);
  const bundledDocs = join(bundledRoot, "docs");
  const bundledSkills = join(bundledRoot, "integrations", "skills");
  if (!existsSync(bundledGuide)) throw new Error(`AGENT_GUIDE_MISSING: ${bundledGuide}`);
  if (!existsSync(bundledDocs)) throw new Error(`AGENT_DOCS_MISSING: ${bundledDocs}`);
  if (!existsSync(bundledSkills)) throw new Error(`AGENT_SKILLS_MISSING: ${bundledSkills}`);

  mkdirSync(dataDir, { recursive: true });
  const guidePath = join(dataDir, AGENT_GUIDE_FILENAME);
  const docsPath = join(dataDir, "docs");
  const skillsPath = join(dataDir, "skills");
  copyFileSync(bundledGuide, guidePath);
  cpSync(bundledDocs, docsPath, { recursive: true, force: true });
  cpSync(bundledSkills, skillsPath, { recursive: true, force: true });
  return { guidePath, docsPath, skillsPath };
}
