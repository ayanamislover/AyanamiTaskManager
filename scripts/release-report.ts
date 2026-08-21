export type StageDecisions = Record<string, { reuse: boolean; reason: string }>;

/**
 * 复用的阶段拿的是上一轮的报告。证据仍然成立——输入逐字节相同才会复用——但
 * 报告必须说出来：读 summary.md 的人分辨不出「本轮测的」和「上一轮测的」，
 * 就等于把没做的事写成做了，而这正是本清单开头禁止的那件事。
 */
export function stageProvenance(stages: StageDecisions | undefined, stage: string): string {
  return stages?.[stage]?.reuse === true ? "（沿用上一轮结果：本轮输入未变）" : "";
}

/**
 * 「已知非阻塞剩余项」原先是写死的“无”，而清单里一直列着四条。发布报告不能
 * 自己编这个答案，只能去清单里读——清单才是这份名单的所在地。
 *
 * 找不到当前版本的小节就抛：那意味着清单没跟着升版重置，此时任何答案都不可信，
 * 而“无”恰好是最坏的那个默认值。
 */
export function nonBlockingItems(checklist: string, version: string): string[] {
  const heading = `## ${version} 非阻塞剩余项`;
  const start = checklist.indexOf(heading);
  if (start < 0) throw new Error(`CHECKLIST_SECTION_MISSING: ${heading}`);
  const rest = checklist.slice(start + heading.length);
  const end = rest.indexOf("\n## ");
  return (end < 0 ? rest : rest.slice(0, end))
    .split(/\r?\n/u)
    .filter((line) => line.trimStart().startsWith("|"))
    .map((line) => line.split("|")[1]?.trim() ?? "")
    .filter((cell) => cell.length > 0 && !/^-+$/u.test(cell))
    .slice(1);
}
