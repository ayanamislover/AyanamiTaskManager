// 检查项证据的纯逻辑，抽出来是为了可单测：UI 包没有组件渲染基础设施。

export type ChecklistEvidenceItem = {
  status: string;
  evidenceRequired?: boolean;
  evidence?: unknown[];
};

export type ChecklistToggleIntent =
  | { action: "request-evidence" }
  | { action: "patch"; status: "TODO" | "DONE" };

// 证据条目历来没有 schema：库里既有纯字符串，也有上百种一次性对象形状。
// 这里只做尽力展示，取常见的说明字段，取不到就压成紧凑 JSON，绝不因形状不符而丢弃。
const evidenceTextKeys = [
  "summary",
  "result",
  "detail",
  "note",
  "claim",
  "ref",
  "path",
  "command",
] as const;

export function evidenceText(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    for (const key of evidenceTextKeys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        const kind = typeof record.kind === "string" ? record.kind : null;
        return kind ? `${kind}: ${value}` : value;
      }
    }
  }
  try {
    return JSON.stringify(entry) ?? String(entry);
  } catch {
    return String(entry);
  }
}

// 必证且尚无证据时，勾选必须先要证据；直接提交会被仓库层的证据闸门拒绝，
// 而那次拒绝在旧实现里是静默的，看起来就像勾选框坏了。
export function checklistToggleIntent(item: ChecklistEvidenceItem): ChecklistToggleIntent {
  if (item.status === "DONE") return { action: "patch", status: "TODO" };
  if (item.evidenceRequired && (item.evidence?.length ?? 0) === 0) {
    return { action: "request-evidence" };
  }
  return { action: "patch", status: "DONE" };
}
