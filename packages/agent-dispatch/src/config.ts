import { z } from "zod";
import { DispatchError } from "./errors.js";
import { readJsonFile, writeJsonAtomic } from "./files.js";

/**
 * 无头会话可用的权限模式。`manual` 会停下来等人确认，`-p` 模式下没人回答，所以不开放；
 * 其余与 `claude --permission-mode` 的取值一一对应。
 */
export const DISPATCH_PERMISSION_MODES = [
  "auto",
  "acceptEdits",
  "bypassPermissions",
  "plan",
] as const;
export const DISPATCH_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** model 会进命令行（npm 装法还要经 cmd.exe），只放行这个字符集。 */
export const DISPATCH_MODEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

export const DispatchConfigSchema = z
  .object({
    enabled: z.boolean(),
    permissionMode: z.enum(DISPATCH_PERMISSION_MODES),
    maxConcurrent: z.number().int().min(1).max(3),
    model: z.string().regex(DISPATCH_MODEL_PATTERN).nullable(),
    effort: z.enum(DISPATCH_EFFORTS).nullable(),
  })
  .strict();

export type DispatchConfig = z.infer<typeof DispatchConfigSchema>;

export const DispatchConfigPatchSchema = DispatchConfigSchema.partial().strict();
export type DispatchConfigPatch = z.infer<typeof DispatchConfigPatchSchema>;

export const DEFAULT_DISPATCH_CONFIG: Readonly<DispatchConfig> = Object.freeze({
  enabled: false,
  permissionMode: "auto",
  maxConcurrent: 1,
  model: null,
  effort: null,
});

/** 读配置；文件不存在用默认值，文件损坏或不合法也回退默认值并记日志（不改写原文件，留给用户排查）。 */
export function loadDispatchConfig(
  path: string,
  // 只要 warn；不从 types.ts 取 DispatchLogger，免得 config ↔ types 成环。
  logger: { warn(message: string, meta?: Record<string, unknown>): void },
): DispatchConfig {
  const read = readJsonFile(path);
  if (read.kind === "missing") return { ...DEFAULT_DISPATCH_CONFIG };
  if (read.kind === "corrupt" || read.kind === "unreadable") {
    logger.warn("派单配置文件无法读取或解析，已回退默认配置", { path, error: read.error });
    return { ...DEFAULT_DISPATCH_CONFIG };
  }
  const parsed = DispatchConfigSchema.safeParse(read.value);
  if (!parsed.success) {
    logger.warn("派单配置文件不合法，已回退默认配置", {
      path,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
    return { ...DEFAULT_DISPATCH_CONFIG };
  }
  return parsed.data;
}

/** 校验补丁并与当前配置合并；不合法时抛 DISPATCH_INVALID_ARGUMENT，带逐项问题。 */
export function mergeDispatchConfig(current: DispatchConfig, patch: unknown): DispatchConfig {
  const parsed = DispatchConfigPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new DispatchError("DISPATCH_INVALID_ARGUMENT", "派单配置不合法", {
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  const next = { ...current };
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) Object.assign(next, { [key]: value });
  }
  return DispatchConfigSchema.parse(next);
}

export function saveDispatchConfig(path: string, config: DispatchConfig): void {
  writeJsonAtomic(path, config);
}
