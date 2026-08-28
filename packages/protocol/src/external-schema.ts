import { AtmError } from "@ayanami-task/errors";
import { z } from "zod";

type ExternalizableObjectSchema = z.ZodObject<z.ZodRawShape>;
export type ExternalNameMap<Schema extends ExternalizableObjectSchema> = {
  readonly [Key in Extract<keyof z.input<Schema>, string>]: string;
};
export type ExternalFieldAdapter = {
  readonly schema: z.ZodType;
  readonly decode: (value: unknown) => unknown;
};

/** Derive a strict wire object from one canonical camelCase Zod object. */
export function externalizeObjectSchema<
  Schema extends ExternalizableObjectSchema,
  Names extends ExternalNameMap<Schema>,
>(
  canonicalSchema: Schema,
  names: Names,
  fieldAdapters: Partial<Record<Extract<keyof z.input<Schema>, string>, ExternalFieldAdapter>> = {},
): {
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  readonly parse: (value: unknown) => z.output<Schema>;
  readonly toCanonical: (value: Record<string, unknown>) => Record<string, unknown>;
} {
  const canonicalShape = canonicalSchema.shape;
  const externalShape: Record<string, any> = {};
  const canonicalKeys = Object.keys(canonicalShape);
  for (const canonicalKey of canonicalKeys) {
    const externalName = names[canonicalKey as keyof Names];
    if (typeof externalName !== "string" || externalName.length === 0) {
      throw new AtmError("EXTERNAL_NAME_MISSING", {
        message: `外部字段名缺失：${canonicalKey}`,
        details: { canonical_key: canonicalKey },
      });
    }
    const fieldAdapter = fieldAdapters[canonicalKey as keyof typeof fieldAdapters];
    externalShape[externalName] = fieldAdapter?.schema ?? canonicalShape[canonicalKey]!;
  }

  const toCanonical = (value: Record<string, unknown>): Record<string, unknown> => {
    const canonical: Record<string, unknown> = {};
    for (const canonicalKey of canonicalKeys) {
      const externalName = names[canonicalKey as keyof Names] as string;
      if (!Object.prototype.hasOwnProperty.call(value, externalName)) continue;
      const fieldAdapter = fieldAdapters[canonicalKey as keyof typeof fieldAdapters];
      canonical[canonicalKey] = fieldAdapter
        ? fieldAdapter.decode(value[externalName])
        : value[externalName];
    }
    return canonical;
  };

  const inputSchema = z
    .object(externalShape)
    .strict()
    .superRefine((value, context) => {
      const parsed = canonicalSchema.safeParse(toCanonical(value));
      if (parsed.success) return;
      for (const issue of parsed.error.issues) {
        const [first, ...rest] = issue.path;
        const externalFirst =
          typeof first === "string" && Object.prototype.hasOwnProperty.call(names, first)
            ? names[first as keyof Names]
            : first;
        context.addIssue({
          ...issue,
          path: first === undefined ? [] : [externalFirst as PropertyKey, ...rest],
        } as Parameters<typeof context.addIssue>[0]);
      }
    });

  return {
    inputSchema,
    parse: (value) => canonicalSchema.parse(toCanonical(inputSchema.parse(value))),
    toCanonical,
  };
}
