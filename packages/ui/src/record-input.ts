import type { UserRecordCreateInput } from "@ayanami-task/client";

export type RecordDraft = {
  opId: string;
  kind: UserRecordCreateInput["kind"];
  importance: NonNullable<UserRecordCreateInput["importance"]>;
  title: string;
  summary: string;
  detail: string;
  topic: string;
  subjectKey: string;
};

export function recordDraftToUserInput(draft: RecordDraft): UserRecordCreateInput {
  const topic = draft.topic.trim();
  const subjectKey = draft.subjectKey.trim();
  return {
    opId: draft.opId,
    kind: draft.kind,
    importance: draft.importance,
    title: draft.title,
    summary: draft.summary,
    detail: draft.detail,
    ...(topic ? { topic } : {}),
    ...(subjectKey ? { subjectKey } : {}),
    scope: "PROJECT",
  };
}
