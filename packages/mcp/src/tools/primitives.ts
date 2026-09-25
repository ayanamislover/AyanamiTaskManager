import { unicodeCodePointLength } from "@ayanami-task/protocol";
import { z } from "zod";

/**
 * 超长时一次说清还要删多少。
 *
 * 客户端常把 maxLength 渲染丢掉，长度问题只能由服务端报；而每被拒一次，调用方都要把整条
 * 请求（常带 3–6KB 的 detail）重传一遍。只给上限的话，它会删到「差不多」再撞一次——
 * 实际发生过 315→301→过。所以直接给出 over_by。
 */
function overLimit(path: string, actual: number, limit: number): string {
  return `INVALID_ARGUMENT ${JSON.stringify({ actual_length: actual, limit, over_by: actual - limit, path })}`;
}

/** 按 Unicode code point 计的必填摘要（record、feedback）。只挂这一个长度检查，避免同一问题报两遍。 */
export function codePointSummary(path: string, limit: number) {
  return z
    .string()
    .trim()
    .min(1)
    .superRefine((value, context) => {
      const actual = unicodeCodePointLength(value);
      if (actual > limit)
        context.addIssue({ code: "custom", message: overLimit(path, actual, limit) });
    })
    .meta({ maxLength: limit });
}

/** 按 zod 默认（UTF-16 码元）计长的文本，超长时同样报出 over_by。 */
export function limitedText(path: string, limit: number, min = 0) {
  // min(0) 会在发布的 schema 里多出 "minLength":0，按描述符预算计费却不表达任何约束。
  return (min > 0 ? z.string().min(min) : z.string()).max(limit, {
    error: (issue) => {
      const actual = typeof issue.input === "string" ? issue.input.length : limit + 1;
      return overLimit(path, actual, limit);
    },
  });
}

export const outputSchema = z.object({}).catchall(z.unknown());
export const projectCode = z.string().trim().min(1).max(20);
export const taskKey = z.string().trim().min(1).max(40);
export const opId = z.string().trim().min(1).max(128);
export const sessionId = z.string().trim().min(1).max(128);
