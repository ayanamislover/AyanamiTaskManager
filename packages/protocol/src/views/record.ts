import { z } from "zod";

export const RecordViewSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    kind: z.string(),
    title: z.string(),
    summary: z.string(),
    detail: z.string(),
    importance: z.string(),
    scope: z.string(),
    workItemKey: z.string().nullable(),
    supersedes: z.string().nullable(),
    status: z.enum(["ACTIVE", "SUPERSEDED", "RETRACTED"]),
    topic: z.string().nullable(),
    subjectKey: z.string().nullable(),
    relatedRecords: z.array(z.string()),
    opId: z.string().nullable(),
    sourceType: z.enum(["USER", "AGENT", "SYSTEM", "IMPORT"]),
    sourceActorId: z.string().nullable(),
    sourceSessionId: z.string().nullable(),
    sourceRef: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type RecordView = z.infer<typeof RecordViewSchema>;

export const RecordPageSchema = z
  .object({
    items: z.array(RecordViewSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();
export type RecordPage = z.infer<typeof RecordPageSchema>;
