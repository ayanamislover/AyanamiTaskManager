import { z } from "zod";

export const outputSchema = z.object({}).catchall(z.unknown());
export const projectCode = z.string().trim().min(1).max(20);
export const taskKey = z.string().trim().min(1).max(40);
export const opId = z.string().trim().min(1).max(128);
export const sessionId = z.string().trim().min(1).max(128);
