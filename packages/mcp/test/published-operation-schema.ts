type JsonSchema = Record<string, any>;

export function dereferencePublishedSchema(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (typeof schema?.$ref !== "string") return schema;
  return schema.$ref
    .replace(/^#\//u, "")
    .split("/")
    .reduce<JsonSchema>((value, segment) => value?.[segment], root);
}

export function publishedOperationVariants(schema: JsonSchema): Map<string, JsonSchema> {
  const found = new Map<string, JsonSchema>();
  const visited = new Set<JsonSchema>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
    const resolved = dereferencePublishedSchema(candidate as JsonSchema, schema);
    if (!resolved || visited.has(resolved)) return;
    visited.add(resolved);
    const rootProperties = resolved.properties ?? {};
    const rootRequired = Array.isArray(resolved.required) ? resolved.required : [];
    const union = Array.isArray(resolved.oneOf)
      ? resolved.oneOf
      : Array.isArray(resolved.anyOf)
        ? resolved.anyOf
        : [];
    for (const candidateBranch of union) {
      const branch = dereferencePublishedSchema(candidateBranch, schema);
      const branchProperties = branch.properties ?? {};
      const operation = dereferencePublishedSchema(branchProperties.operation ?? {}, schema);
      const names =
        typeof operation.const === "string"
          ? [operation.const]
          : Array.isArray(operation.enum)
            ? operation.enum.filter((value: unknown): value is string => typeof value === "string")
            : [];
      const effective = {
        type: "object",
        properties: { ...rootProperties, ...branchProperties },
        required: [
          ...new Set([...rootRequired, ...(Array.isArray(branch.required) ? branch.required : [])]),
        ],
        additionalProperties:
          resolved.unevaluatedProperties === false || resolved.additionalProperties === false
            ? false
            : undefined,
      };
      for (const name of names) found.set(name, effective);
    }
    for (const value of Object.values(resolved)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(schema);
  return found;
}

export function publishedOperationVariant(schema: JsonSchema, operation: string): JsonSchema {
  const variant = publishedOperationVariants(schema).get(operation);
  if (!variant) throw new Error(`MISSING_OPERATION_VARIANT:${operation}`);
  return variant;
}
