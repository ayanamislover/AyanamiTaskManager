import { z } from "zod";

export const SessionRoleSchema = z.enum(["PRIMARY", "SUBAGENT", "REVIEWER", "OBSERVER"]);
export type SessionRole = z.infer<typeof SessionRoleSchema>;

export const SessionGitViewSchema = z
  .object({
    available: z.boolean(),
    repoRoot: z.string().nullable(),
    worktreeRoot: z.string().nullable(),
    commonDir: z.string().nullable(),
    isLinkedWorktree: z.boolean().nullable(),
    branch: z.string().nullable(),
    head: z.string().nullable(),
    detached: z.boolean().nullable(),
    dirty: z.boolean().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type SessionGitView = z.infer<typeof SessionGitViewSchema>;

/** Canonical application/REST view. MCP owns the snake_case projection. */
export const SessionViewSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    displayName: z.string(),
    clientKind: z.string(),
    capabilities: z.array(z.unknown()),
    parentSessionId: z.string().nullable(),
    predecessorSessionId: z.string().nullable(),
    threadId: z.string().nullable(),
    role: SessionRoleSchema,
    cwd: z.string().nullable(),
    workState: z.string(),
    connectionState: z.string(),
    currentTaskKey: z.string().nullable(),
    heartbeatAt: z.string().nullable(),
    lastSeenAt: z.string(),
    version: z.number().int().nonnegative(),
    startedAt: z.string(),
    updatedAt: z.string(),
    closedAt: z.string().nullable(),
    retirementReason: z.string().nullable(),
    closeReason: z.string().nullable(),
    git: SessionGitViewSchema,
  })
  .strict();
export type SessionView = z.infer<typeof SessionViewSchema>;

export const SessionPageSchema = z
  .object({
    items: z.array(SessionViewSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();
export type SessionPage = z.infer<typeof SessionPageSchema>;
