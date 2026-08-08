import { createHash } from "node:crypto";

export type AgentTaskImportObjective = { ref: string; title: string; line: number };
export type AgentTaskImportMilestone = {
  ref: string;
  objectiveRef: string;
  title: string;
  line: number;
};
export type AgentTaskImportTask = {
  ref: string;
  objectiveRef: string;
  milestoneRef: string | null;
  title: string;
  completed: boolean;
  line: number;
};
export type AgentTaskImportRecord = { title: string; detail: string; line: number };

export type AgentTaskImportPlan = {
  sha256: string;
  sourceName: string;
  objectives: AgentTaskImportObjective[];
  milestones: AgentTaskImportMilestone[];
  tasks: AgentTaskImportTask[];
  records: AgentTaskImportRecord[];
  warnings: string[];
};

export function parseAgentTaskMarkdown(
  content: string,
  sourceName = "agenttask.md",
): AgentTaskImportPlan {
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const objectives: AgentTaskImportObjective[] = [];
  const milestones: AgentTaskImportMilestone[] = [];
  const tasks: AgentTaskImportTask[] = [];
  const records: AgentTaskImportRecord[] = [];
  const warnings: string[] = [];
  let currentObjective: AgentTaskImportObjective | null = null;
  let currentMilestone: AgentTaskImportMilestone | null = null;

  const ensureObjective = (line: number): AgentTaskImportObjective => {
    if (currentObjective) return currentObjective;
    const objective = { ref: "objective-imported", title: "导入任务", line };
    objectives.push(objective);
    currentObjective = objective;
    warnings.push("源文件在首个一级标题前包含任务，已归入“导入任务”目标。");
    return objective;
  };

  for (const [index, rawLine] of content.replaceAll("\r\n", "\n").split("\n").entries()) {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      if (level === 1) {
        currentObjective = { ref: `objective-${line}`, title, line };
        objectives.push(currentObjective);
        currentMilestone = null;
      } else if (level === 2) {
        const objective = ensureObjective(line);
        currentMilestone = { ref: `milestone-${line}`, objectiveRef: objective.ref, title, line };
        milestones.push(currentMilestone);
      } else {
        records.push({ title: `标题：${title}`, detail: `第 ${line} 行\n${rawLine}`, line });
      }
      continue;
    }
    const checkbox = rawLine.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/u);
    if (checkbox) {
      const objective = ensureObjective(line);
      tasks.push({
        ref: `task-${line}`,
        objectiveRef: objective.ref,
        milestoneRef: currentMilestone?.ref ?? null,
        title: checkbox[2]!.trim(),
        completed: checkbox[1]!.toLowerCase() === "x",
        line,
      });
      continue;
    }
    const listItem = rawLine.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/u);
    const detail = listItem?.[1]?.trim() ?? trimmed;
    records.push({ title: detail.slice(0, 80), detail: `第 ${line} 行\n${rawLine}`, line });
  }

  if (content.trim() && objectives.length === 0 && tasks.length === 0) {
    warnings.push("未识别到标题或 checkbox，全部内容将保留为参考记录。");
  }
  return { sha256, sourceName, objectives, milestones, tasks, records, warnings };
}
