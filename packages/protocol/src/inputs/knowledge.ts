import { z } from "zod";

const Text = z.string().trim().min(1);
export const KnowledgeSourceSchema = z
  .object({
    type: z.enum(["project_record", "file", "url", "manual"]),
    reference: Text.max(2000),
    sourceVersion: z.number().int().nonnegative().optional(),
    projectId: Text.max(100).optional(),
    recordId: Text.max(100).optional(),
  })
  .superRefine((value, context) => {
    if (
      value.type === "project_record" &&
      (value.sourceVersion === undefined || !value.projectId || !value.recordId)
    ) {
      context.addIssue({
        code: "custom",
        message: "项目 Record 来源必须固定 projectId、recordId 和 sourceVersion",
      });
    }
  });
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;
export const KnowledgeContentSchema = z.object({
  slug: Text.max(160),
  title: Text.max(240),
  summary: Text.max(1000),
  useWhen: z.string().max(2000).default(""),
  tags: z.array(Text.max(80)).max(30).default([]),
  aliases: z.array(Text.max(160)).max(30).default([]),
  appliesTo: z.array(Text.max(200)).max(30).default([]),
  bodyMarkdown: z.string().max(500_000),
  sourceRefs: z.array(KnowledgeSourceSchema).max(30).default([]),
});
export type KnowledgeContent = z.input<typeof KnowledgeContentSchema>;
export const KnowledgeSaveInputSchema = KnowledgeContentSchema.extend({
  opId: Text.max(200),
  id: Text.max(100).optional(),
  expectedVersion: z.number().int().nonnegative(),
  expectedRevisionId: Text.max(100).optional(),
}).superRefine((value, context) => {
  if (value.id && !value.expectedRevisionId)
    context.addIssue({
      code: "custom",
      path: ["expectedRevisionId"],
      message: "更新知识必须带当前修订的 revisionId，防止备份恢复后版本号重用",
    });
});
export const KnowledgeArchiveInputSchema = z.object({
  opId: Text.max(200),
  id: Text.max(100),
  expectedVersion: z.number().int().positive(),
  expectedRevisionId: Text.max(100),
  archived: z.boolean(),
});
export const KnowledgeSearchInputSchema = z.object({
  query: z.string().trim().max(500).default(""),
  tag: Text.max(80).optional(),
  includeArchived: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(5),
  maxChars: z.number().int().min(1).max(50_000).default(2400),
  cursor: Text.max(4000).optional(),
});
export const KnowledgeGetInputSchema = z.object({
  id: Text.max(100),
  revisionId: z
    .string()
    .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u)
    .optional(),
  section: Text.max(200).optional(),
  maxChars: z.number().int().min(1).max(600_000).default(6000),
  cursor: Text.max(4000).optional(),
});
export const KnowledgeRevisionSchema = KnowledgeContentSchema.extend({
  id: Text,
  revision: z.number().int().positive(),
  revisionId: Text,
  createdAt: Text,
});
export const KnowledgeEntrySchema = KnowledgeRevisionSchema.extend({
  version: z.number().int().positive(),
  archived: z.boolean(),
});
export const KnowledgeHitSchema = KnowledgeEntrySchema.omit({
  bodyMarkdown: true,
  sourceRefs: true,
  aliases: true,
});
export const KnowledgeSearchPageSchema = z.object({
  hits: z.array(KnowledgeHitSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
export const KnowledgeGetPageSchema = KnowledgeEntrySchema.extend({
  toc: z.array(z.object({ id: z.string(), title: z.string(), level: z.number().int() })),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
});
// Agent reads omit management/display fields. Continuations carry only the
// immutable identity, current archive warning, body chunk and paging control.
export const KnowledgeAgentHitSchema = KnowledgeHitSchema.omit({
  slug: true,
  version: true,
  revision: true,
  createdAt: true,
});
export const KnowledgeAgentSearchPageSchema = KnowledgeSearchPageSchema.extend({
  hits: z.array(KnowledgeAgentHitSchema),
});
export const KnowledgeAgentContinuationSchema = KnowledgeGetPageSchema.pick({
  id: true,
  revisionId: true,
  archived: true,
  bodyMarkdown: true,
  truncated: true,
  nextCursor: true,
});
export const KnowledgeAgentFirstPageSchema = KnowledgeGetPageSchema.pick({
  id: true,
  revisionId: true,
  archived: true,
  bodyMarkdown: true,
  truncated: true,
  nextCursor: true,
  title: true,
  useWhen: true,
  appliesTo: true,
  sourceRefs: true,
  toc: true,
}).extend({ tocTotal: z.number().int().nonnegative(), tocTruncated: z.boolean() });
export const KnowledgeAgentGetPageSchema = z.union([
  KnowledgeAgentFirstPageSchema,
  KnowledgeAgentContinuationSchema,
]);
export type KnowledgeAgentSearchPage = z.infer<typeof KnowledgeAgentSearchPageSchema>;
export type KnowledgeAgentGetPage = z.infer<typeof KnowledgeAgentGetPageSchema>;
export type KnowledgeSaveInput = z.input<typeof KnowledgeSaveInputSchema>;
export type KnowledgeArchiveInput = z.input<typeof KnowledgeArchiveInputSchema>;
export type KnowledgeSearchInput = z.input<typeof KnowledgeSearchInputSchema>;
export type KnowledgeGetInput = z.input<typeof KnowledgeGetInputSchema>;
export type KnowledgeRevision = z.infer<typeof KnowledgeRevisionSchema>;
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;
export type KnowledgeHit = z.infer<typeof KnowledgeHitSchema>;
export type KnowledgeSearchPage = z.infer<typeof KnowledgeSearchPageSchema>;
export type KnowledgeGetPage = z.infer<typeof KnowledgeGetPageSchema>;
