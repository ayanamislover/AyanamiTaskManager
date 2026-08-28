import { z } from "zod";
import { CoordinationModeSchema } from "../domain.js";
import { NonEmptyTextSchema, NullableDateOnlySchema, OpIdSchema } from "../schema-primitives.js";
import { PrioritySchema, WorkItemStatusSchema, WorkItemTypeSchema } from "../work-item.js";

export const CreateProjectInputSchema = z.object({
  name: NonEmptyTextSchema.max(200),
  sourcePath: z.string().min(1).nullable(),
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9-]{1,11}$/u)
    .optional(),
  description: z.string().max(10_000).default(""),
  coordinationMode: CoordinationModeSchema.default("AUTO"),
  creationReason: z.string().max(500).optional(),
  creationSignals: z.record(z.string(), z.unknown()).default({}),
});

export const BeginSignalsSchema = z.object({
  expectedMinutes: z.number().int().nonnegative().optional(),
  subtaskCount: z.number().int().nonnegative().optional(),
  multiSession: z.boolean().optional(),
  multiAgent: z.boolean().optional(),
  hasDependencies: z.boolean().optional(),
  needsEvidence: z.boolean().optional(),
  hasTargetDate: z.boolean().optional(),
});

export const BeginInputSchema = z.object({
  operationId: OpIdSchema.optional(),
  cwd: z.string().min(1).optional(),
  projectCode: z.string().optional(),
  title: z.string().max(400).optional(),
  mode: z.enum(["auto", "quick", "project"]).default("auto"),
  agentId: NonEmptyTextSchema.max(128),
  displayName: z.string().max(200).optional(),
  clientKind: z.string().max(100).default("generic"),
  threadId: z.string().max(256).nullable().optional(),
  parentSessionId: z.string().max(128).nullable().optional(),
  resume: z.boolean().default(false),
  predecessorSessionId: z.string().max(128).nullable().optional(),
  maxChars: z.number().int().min(400).max(5000).default(1200),
  role: z.enum(["PRIMARY", "SUBAGENT", "REVIEWER", "OBSERVER"]).default("PRIMARY"),
  signals: BeginSignalsSchema.default({}),
  allowProjectCreate: z.boolean().default(false),
  creationReason: z.string().max(500).optional(),
});

export const CreateObjectiveInputSchema = z.object({
  title: NonEmptyTextSchema.max(400),
  description: z.string().max(20_000).default(""),
  definitionOfDone: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
});

export const CreateMilestoneInputSchema = z.object({
  objectiveId: NonEmptyTextSchema,
  title: NonEmptyTextSchema.max(400),
  description: z.string().max(20_000).default(""),
  targetDate: NullableDateOnlySchema,
});

export const ChecklistCreateInputSchema = z.object({
  title: NonEmptyTextSchema.max(400),
  evidenceRequired: z.boolean().default(false),
  weight: z.number().positive().max(1000).default(1),
});

export const EvidenceReferenceSchema = z.object({
  kind: z.enum(["git_sha", "atm_record", "atm_task", "test_result", "url", "file"]),
  value: NonEmptyTextSchema.max(2000),
  note: z.string().trim().max(500).optional(),
});

export const EvidenceInputSchema = z.union([NonEmptyTextSchema.max(2000), EvidenceReferenceSchema]);
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;

export const ReviewCandidateHashSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_.:-]*$/iu),
  value: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{7,128}$/iu),
});

export const ReviewCandidateHashesSchema = z
  .array(ReviewCandidateHashSchema)
  .min(1)
  .max(20)
  .superRefine((hashes, context) => {
    const names = new Set<string>();
    for (const [index, hash] of hashes.entries()) {
      const normalized = hash.name.toLowerCase();
      if (names.has(normalized)) {
        context.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `重复候选 hash 名称: ${normalized}`,
        });
      }
      names.add(normalized);
    }
  });

export function normalizeReviewCandidateHashes(
  hashes: ReadonlyArray<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
  return ReviewCandidateHashesSchema.parse(hashes)
    .map((hash) => ({
      name: hash.name.trim().toLowerCase(),
      value: hash.value.trim().toLowerCase(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export const ReviewRequestCreateInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  reviewTaskKey: NonEmptyTextSchema.max(100),
  expectedReviewTaskVersion: z.number().int().nonnegative(),
  parentChecklistId: NonEmptyTextSchema.max(128),
  expectedParentChecklistVersion: z.number().int().nonnegative(),
  expectedCandidateHashes: ReviewCandidateHashesSchema,
});

export const ReviewSubmitInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  requestKey: NonEmptyTextSchema.max(128),
  expectedReviewTaskVersion: z.number().int().nonnegative(),
  verdict: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
  reviewedHashes: ReviewCandidateHashesSchema,
  evidence: z.array(EvidenceReferenceSchema).min(1).max(100),
});

export const ProgressCompletedInputSchema = z.union([
  z.string().max(500),
  z.object({
    text: NonEmptyTextSchema.max(500),
    workItemKey: NonEmptyTextSchema.max(100).optional(),
  }),
]);

export const WorkItemCreateInputSchema = z
  .object({
    clientRef: NonEmptyTextSchema.max(100),
    objectiveId: NonEmptyTextSchema.optional(),
    milestoneId: z.string().nullable().optional(),
    parentKey: z.string().nullable().optional(),
    parentRef: z.string().nullable().optional(),
    dependsOn: z.array(z.string()).max(50).default([]),
    dependsOnRefs: z.array(z.string()).max(50).default([]),
    discoveredFrom: NonEmptyTextSchema.max(100).optional(),
    discoveredFromRef: NonEmptyTextSchema.max(100).optional(),
    title: NonEmptyTextSchema.max(400),
    description: z.string().max(50_000).default(""),
    type: WorkItemTypeSchema.default("TASK"),
    priority: PrioritySchema.default("NORMAL"),
    status: WorkItemStatusSchema.default("BACKLOG"),
    acceptance: z.array(z.string().trim().min(1).max(1000)).max(100).default([]),
    checklist: z.array(ChecklistCreateInputSchema).max(100).default([]),
    weight: z.number().positive().max(1000).default(1),
    targetDate: NullableDateOnlySchema,
    verificationRequired: z.boolean().default(false),
    assigneeAgentId: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .refine((value) => !(value.discoveredFrom && value.discoveredFromRef), {
    message: "discoveredFrom 与 discoveredFromRef 只能指定一个",
    path: ["discoveredFromRef"],
  });

export const TaskCreateBatchInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  items: z.array(WorkItemCreateInputSchema).min(1).max(50),
});

export type BeginInput = z.infer<typeof BeginInputSchema>;
export type WorkItemCreateInput = z.infer<typeof WorkItemCreateInputSchema>;
export type ReviewRequestCreateInput = z.infer<typeof ReviewRequestCreateInputSchema>;
export type ReviewSubmitInput = z.infer<typeof ReviewSubmitInputSchema>;
