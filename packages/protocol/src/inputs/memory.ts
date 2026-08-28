import { z } from "zod";
import { ProjectHealthSchema, RecordKindSchema } from "../domain.js";
import {
  NonEmptyTextSchema,
  NullableDateOnlySchema,
  OpIdSchema,
  RecordSummarySchema,
} from "../schema-primitives.js";
import { EvidenceInputSchema, ProgressCompletedInputSchema } from "./planning.js";

export const ProgressAddInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  scope: z.enum(["task", "project"]),
  taskKey: z.string().optional(),
  percent: z.number().min(0).max(100).optional(),
  summary: NonEmptyTextSchema.max(500),
  completed: z.array(ProgressCompletedInputSchema).max(20).default([]),
  next: z.array(z.string().max(500)).max(20).default([]),
  blocker: z.string().max(1000).nullable().optional(),
  health: ProjectHealthSchema.nullable().optional(),
  evidence: z.array(EvidenceInputSchema).max(20).default([]),
});

export const RecordTopicSchema = z.string().trim().min(1).max(200);
export const RecordSubjectKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u, "subjectKey 必须是稳定、无空白的主题标识");
export const RecordInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  kind: RecordKindSchema,
  title: NonEmptyTextSchema.max(400),
  summary: RecordSummarySchema,
  detail: z.string().max(100_000).default(""),
  importance: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).default("NORMAL"),
  scope: z.string().max(100).default("PROJECT"),
  workItemKey: z.string().nullable().optional(),
  supersedes: z.string().nullable().optional(),
  topic: RecordTopicSchema.nullable().optional(),
  subjectKey: RecordSubjectKeySchema.nullable().optional(),
});
export const SearchInputSchema = z.object({
  project: z.string().optional(),
  query: NonEmptyTextSchema.max(500),
  limit: z.number().int().min(1).max(30).default(20),
  cursor: z.string().min(1).max(4000).optional(),
});
export const SearchHitSchema = z.object({
  entityType: z.string(),
  entityKey: z.string(),
  title: z.string(),
  snippet: z.string(),
  updatedAt: z.string(),
  project: z.string().nullable().optional(),
});
export const SearchPageSchema = z.object({
  hits: z.array(SearchHitSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export const DeltaInputSchema = z.object({
  project: NonEmptyTextSchema,
  sinceSeq: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100).default(50),
  types: z.array(z.string()).max(50).default([]),
});
export const EndInputSchema = z.object({
  session: NonEmptyTextSchema,
  project: NonEmptyTextSchema,
  opId: OpIdSchema,
  outcome: z.enum(["completed", "paused", "blocked", "cancelled", "error", "retired"]),
  summary: NonEmptyTextSchema.max(500),
  next: z.array(z.string().max(500)).max(20).default([]),
  releaseClaims: z.boolean().default(true),
  retirementReason: z.string().max(500).nullable().optional(),
});
export const QuickTaskCreateInputSchema = z.object({
  title: NonEmptyTextSchema.max(400),
  note: z.string().max(5000).default(""),
  dueDate: NullableDateOnlySchema,
  sourceCwd: z.string().nullable().optional(),
  actor: z.string().default("USER"),
});

export type RecordInput = z.input<typeof RecordInputSchema>;
export type ProgressAddInput = z.infer<typeof ProgressAddInputSchema>;
export type SearchInput = z.infer<typeof SearchInputSchema>;
export type SearchHit = z.infer<typeof SearchHitSchema>;
export type SearchPage = z.infer<typeof SearchPageSchema>;
