import { z } from "zod";

export const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
export const NullableDateOnlySchema = DateOnlySchema.nullable().optional();
export const NonEmptyTextSchema = z.string().trim().min(1);
export const OpIdSchema = z.string().trim().min(1).max(128);

export const RECORD_SUMMARY_CODE_POINT_LIMIT = 300;

export function unicodeCodePointLength(value: string): number {
  return Array.from(value).length;
}

export const RecordSummarySchema = NonEmptyTextSchema.superRefine((value, context) => {
  if (unicodeCodePointLength(value) <= RECORD_SUMMARY_CODE_POINT_LIMIT) return;
  context.addIssue({
    code: "too_big",
    origin: "string",
    maximum: RECORD_SUMMARY_CODE_POINT_LIMIT,
    inclusive: true,
    message: `摘要不能超过 ${RECORD_SUMMARY_CODE_POINT_LIMIT} 个 Unicode code point`,
  });
}).meta({ maxLength: RECORD_SUMMARY_CODE_POINT_LIMIT });
