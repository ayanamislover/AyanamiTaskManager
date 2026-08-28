import { z } from "zod";

export const PROJECTION_STATUSES = ["APPLIED", "DEFERRED"] as const;
export const ProjectionStatusSchema = z.enum(PROJECTION_STATUSES);
export type ProjectionStatus = z.infer<typeof ProjectionStatusSchema>;

export const ProjectionProjectSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    lifecycle: z.string(),
  })
  .strict();
export type ProjectionProject = z.infer<typeof ProjectionProjectSchema>;

export const ProjectionReceiptSchema = z
  .object({
    status: ProjectionStatusSchema,
    sourceSeq: z.number().int().nonnegative(),
    projectedSeq: z.number().int().nonnegative(),
    lag: z.number().int(),
    retryScheduled: z.boolean(),
    lastError: z.string().nullable(),
    retryCount: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectionReceipt = z.infer<typeof ProjectionReceiptSchema>;

export const ProjectionStateViewSchema = ProjectionReceiptSchema.extend({
  project: ProjectionProjectSchema,
  updatedAt: z.string(),
}).strict();
export type ProjectionStateView = z.infer<typeof ProjectionStateViewSchema>;

export const ProjectionReconcileReceiptSchema = z
  .object({
    ok: z.literal(true),
    project: ProjectionProjectSchema,
    delivered: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    attemptedAt: z.string(),
    projection: ProjectionReceiptSchema,
  })
  .strict();
export type ProjectionReconcileReceipt = z.infer<typeof ProjectionReconcileReceiptSchema>;

export const ProjectionBatchFailureSchema = z
  .object({
    project: ProjectionProjectSchema,
    code: z.string(),
    message: z.string(),
  })
  .strict();
export type ProjectionBatchFailure = z.infer<typeof ProjectionBatchFailureSchema>;

export const ProjectionBatchReceiptSchema = z
  .object({
    ok: z.literal(true),
    attempted: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    deferred: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    attemptedAt: z.string(),
    finishedAt: z.string(),
    results: z.array(ProjectionReconcileReceiptSchema),
    failures: z.array(ProjectionBatchFailureSchema),
  })
  .strict();
export type ProjectionBatchReceipt = z.infer<typeof ProjectionBatchReceiptSchema>;

export type ProjectionSummary = {
  status: ProjectionStatus;
  total: number;
  appliedCount: number;
  deferredCount: number;
  missingCount: number;
  retryScheduledCount: number;
  lagging: number;
  maxLag: number;
  totalLag: number;
};

export type ProjectionFailureView = {
  project: ProjectionProject;
  reason: "DEFERRED" | "MISSING" | "INVERTED";
  lag: number | null;
  lastError: string | null;
  state: ProjectionStateView | null;
};
