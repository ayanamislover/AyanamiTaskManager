/**
 * 发布用 JSON Schema 的表示算法。
 *
 * 这里只做等价改写：规范化、结构去重、判别式 union 压缩、稳定哈希。它不认识任何
 * ATM 工具名，也不认识任何字段路径——发什么工具是 tool-publication.ts 的事。
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export type JsonObject = Record<string, unknown>;

const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const schemaArrayKeywords = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaValueKeywords = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function isNullOnlySchema(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    value.type === "null" &&
    Object.keys(value).every((key) => key === "type")
  );
}

function mergeNullableAnyOf(schema: JsonObject): JsonObject {
  const branches = schema.anyOf;
  if (!Array.isArray(branches)) return schema;
  const nullBranches = branches.filter(isNullOnlySchema);
  const valueBranches = branches.filter((branch) => !isNullOnlySchema(branch));
  if (nullBranches.length !== 1 || valueBranches.length !== 1) return schema;
  const valueBranch = valueBranches[0];
  if (!isJsonObject(valueBranch)) return schema;
  // enum/const do not automatically admit null. Hoisting null into `type`
  // while leaving either keyword unchanged would silently reject the nullable
  // branch, so those unions intentionally stay explicit.
  if (valueBranch.enum !== undefined || valueBranch.const !== undefined) return schema;
  const valueTypes = Array.isArray(valueBranch.type)
    ? valueBranch.type.filter((value): value is string => typeof value === "string")
    : typeof valueBranch.type === "string"
      ? [valueBranch.type]
      : [];
  if (valueTypes.length === 0) return schema;
  const outer = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "anyOf"));
  return {
    ...outer,
    ...valueBranch,
    type: [...new Set([...valueTypes, "null"])],
  };
}

/**
 * Recursively applies representation-only JSON Schema reductions. This is a
 * schema algorithm: it never branches on an ATM tool name or a field path.
 */
function normalizeSchemaNode(value: unknown): unknown {
  if (!isJsonObject(value)) return value;

  const normalized: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema" || key === "title" || key === "examples") continue;
    if (schemaMapKeywords.has(key) && isJsonObject(child)) {
      normalized[key] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [name, normalizeSchemaNode(schema)]),
      );
    } else if (schemaArrayKeywords.has(key) && Array.isArray(child)) {
      normalized[key] = child.map(normalizeSchemaNode);
    } else if (schemaValueKeywords.has(key) && isJsonObject(child)) {
      normalized[key] = normalizeSchemaNode(child);
    } else {
      normalized[key] = structuredClone(child);
    }
  }

  // Keep Zod's scalar type beside both enum and const, including boolean
  // constants. This preserves a self-contained descriptor for host renderers
  // without widening the accepted set; actual host display needs its own check.

  return mergeNullableAnyOf(normalized);
}

type SchemaLocation = {
  readonly parent: JsonObject | unknown[];
  readonly key: string | number;
  readonly node: JsonObject;
};

function schemaChildren(node: JsonObject): SchemaLocation[] {
  const children: SchemaLocation[] = [];
  for (const [keyword, value] of Object.entries(node)) {
    if (schemaMapKeywords.has(keyword) && isJsonObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (isJsonObject(child)) children.push({ parent: value, key, node: child });
      }
      continue;
    }
    if (schemaArrayKeywords.has(keyword) && Array.isArray(value)) {
      value.forEach((child, index) => {
        if (isJsonObject(child)) children.push({ parent: value, key: index, node: child });
      });
      continue;
    }
    if (schemaValueKeywords.has(keyword) && isJsonObject(value)) {
      children.push({ parent: node, key: keyword, node: value });
    }
  }
  return children;
}

function collectSchemaLocations(root: JsonObject): Map<string, SchemaLocation[]> {
  const locations = new Map<string, SchemaLocation[]>();
  const visit = (node: JsonObject): void => {
    for (const child of schemaChildren(node)) {
      const key = stableJson(child.node);
      const matches = locations.get(key) ?? [];
      matches.push(child);
      locations.set(key, matches);
      visit(child.node);
    }
  };
  visit(root);
  return locations;
}

function referenceFor(id: string): JsonObject {
  return { $ref: `#/$defs/${id}` };
}

function shortestHashId(hash: string, definitions: JsonObject): string {
  for (let length = 2; length <= hash.length; length += 1) {
    const candidate = hash.slice(0, length);
    if (!(candidate in definitions)) return candidate;
  }
  throw new Error("PUBLIC_SCHEMA_HASH_COLLISION");
}

/**
 * Hoists only repetitions whose serialized replacement is strictly smaller.
 * Candidates and identifiers come from canonical subtree hashes; overlapping
 * candidates are re-counted after every replacement so output is deterministic.
 */
export function deduplicateSchema(root: JsonObject): JsonObject {
  const definitions: JsonObject = {};
  let wrapperCost = JSON.stringify({ $defs: {} }).length - 2;
  for (;;) {
    const candidates = [...collectSchemaLocations(root).entries()]
      .filter(([, locations]) => locations.length > 1)
      .map(([canonical, locations]) => {
        const hash = digest(locations[0]!.node);
        const id = shortestHashId(hash, definitions);
        const referenceBytes = JSON.stringify(referenceFor(id)).length;
        const definitionBytes = JSON.stringify(id).length + 1 + canonical.length;
        const saving =
          locations.length * canonical.length -
          (locations.length * referenceBytes + definitionBytes + wrapperCost);
        return { canonical, locations, hash, id, saving };
      })
      .filter((candidate) => candidate.saving > 0)
      .sort(
        (left, right) =>
          right.saving - left.saving ||
          left.hash.localeCompare(right.hash) ||
          left.canonical.localeCompare(right.canonical),
      );
    const selected = candidates[0];
    if (!selected) break;
    const definition = structuredClone(selected.locations[0]!.node);
    definitions[selected.id] = definition;
    for (const location of selected.locations) {
      location.parent[location.key as never] = referenceFor(selected.id) as never;
    }
    wrapperCost = 1;
  }
  if (Object.keys(definitions).length > 0) root.$defs = definitions;
  return root;
}

export function normalizePublishedSchema(schema: JsonObject): JsonObject {
  const normalized = normalizeSchemaNode(structuredClone(schema));
  if (!isJsonObject(normalized)) throw new Error("PUBLIC_SCHEMA_MUST_BE_OBJECT");
  return deduplicateSchema(normalized);
}

export function canonicalRuntimeSchema(schema: z.ZodType): JsonObject {
  const converted = z.toJSONSchema(schema, { io: "input", reused: "inline" });
  if (!isJsonObject(converted)) throw new Error("PUBLIC_SCHEMA_MUST_BE_OBJECT");
  const normalized = normalizeSchemaNode(converted);
  if (!isJsonObject(normalized)) throw new Error("PUBLIC_SCHEMA_MUST_BE_OBJECT");
  return normalized;
}

export function compactDiscriminatedObjectUnions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactDiscriminatedObjectUnions);
  if (!isJsonObject(value)) return value;

  const compacted = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, compactDiscriminatedObjectUnions(child)]),
  ) as JsonObject;
  const unionKey = Array.isArray(compacted.oneOf)
    ? "oneOf"
    : Array.isArray(compacted.anyOf)
      ? "anyOf"
      : null;
  if (!unionKey) return compacted;
  const branches = compacted[unionKey] as unknown[];
  if (
    branches.length < 2 ||
    !branches.every(
      (branch) =>
        isJsonObject(branch) &&
        branch.type === "object" &&
        isJsonObject(branch.properties) &&
        branch.additionalProperties === false &&
        Object.keys(branch).every((key) =>
          ["additionalProperties", "properties", "required", "type"].includes(key),
        ),
    )
  ) {
    return compacted;
  }

  const objects = branches as JsonObject[];
  const discriminator = Object.keys(objects[0]!.properties as JsonObject)
    .filter((property) =>
      objects.every((branch) => {
        const schema = (branch.properties as JsonObject)[property];
        return isJsonObject(schema) && typeof schema.const === "string";
      }),
    )
    .filter((property) => {
      const values = objects.map(
        (branch) => ((branch.properties as JsonObject)[property] as JsonObject).const,
      );
      return new Set(values).size === values.length;
    })
    .sort()[0];
  if (!discriminator) return compacted;

  const propertyNames = [
    ...new Set(objects.flatMap((branch) => Object.keys(branch.properties as JsonObject))),
  ];
  const properties: JsonObject = {};
  const commonProperties = new Set<string>();
  for (const property of propertyNames) {
    const schemas = objects
      .map((branch) => (branch.properties as JsonObject)[property])
      .filter((schema): schema is JsonObject => isJsonObject(schema));
    const canonical = [...new Set(schemas.map(stableJson))];
    if (schemas.length === objects.length && canonical.length === 1) {
      properties[property] = structuredClone(schemas[0]!);
      commonProperties.add(property);
    }
  }

  const requiredSets = objects.map(
    (branch) =>
      new Set(
        Array.isArray(branch.required)
          ? branch.required.filter((field): field is string => typeof field === "string")
          : [],
      ),
  );
  const commonRequired = [...requiredSets[0]!].filter((field) =>
    requiredSets.every((required) => required.has(field)),
  );
  const sharedProperties = Object.fromEntries(
    [...commonProperties].map((property) => [property, structuredClone(properties[property])]),
  );
  const compactBranches = objects.map((branch, index) => {
    const branchProperties = branch.properties as JsonObject;
    const scopedProperties = Object.fromEntries(
      Object.entries(branchProperties).filter(
        ([property]) => property === discriminator || !commonProperties.has(property),
      ),
    );
    const specificRequired = [...requiredSets[index]!].filter(
      (field) => !commonRequired.includes(field),
    );
    const branchRequired = [...new Set([...commonRequired, ...specificRequired])];
    return {
      // Keep the shared identity fields in every branch as well as in the
      // compact envelope. A host that renders only a oneOf/anyOf branch must
      // still show task_key/expected_version and the required discriminator;
      // duplicating identical constraints is representation-only and keeps the
      // branch independently actionable without changing validation semantics.
      properties: { ...sharedProperties, ...scopedProperties },
      ...(branchRequired.length === 0 ? {} : { required: branchRequired }),
    };
  });

  const groupedBranches = new Map<
    string,
    { template: JsonObject; discriminatorValues: string[] }
  >();
  for (const branch of compactBranches) {
    const branchProperties = branch.properties as JsonObject;
    const discriminatorSchema = branchProperties[discriminator] as JsonObject;
    const discriminatorValue = String(discriminatorSchema.const);
    const otherProperties = Object.fromEntries(
      Object.entries(branchProperties).filter(([property]) => property !== discriminator),
    );
    const signature = stableJson({
      properties: otherProperties,
      ...(branch.required === undefined ? {} : { required: branch.required }),
    });
    const group = groupedBranches.get(signature);
    if (group) group.discriminatorValues.push(discriminatorValue);
    else {
      groupedBranches.set(signature, {
        template: {
          properties: otherProperties,
          ...(branch.required === undefined ? {} : { required: branch.required }),
        },
        discriminatorValues: [discriminatorValue],
      });
    }
  }

  const grouped = [...groupedBranches.values()].map(({ template, discriminatorValues }) => ({
    ...template,
    properties: {
      [discriminator]:
        discriminatorValues.length === 1
          ? { type: "string", const: discriminatorValues[0] }
          : { type: "string", enum: discriminatorValues },
      ...(template.properties as JsonObject),
    },
  }));

  const remainder = Object.fromEntries(
    Object.entries(compacted).filter(([key]) => key !== unionKey),
  );
  return {
    ...remainder,
    type: "object",
    properties,
    ...(commonRequired.length === 0 ? {} : { required: commonRequired }),
    unevaluatedProperties: false,
    [unionKey]: grouped,
  };
}

export function semanticSchemaHash(schema: JsonObject): string {
  const normalized = normalizeSchemaNode(structuredClone(schema));
  return digest(normalized);
}

export function isUninformativeObjectSchema(schema: JsonObject): boolean {
  const keys = Object.keys(schema);
  const properties = schema.properties;
  const required = schema.required;
  const additionalProperties = schema.additionalProperties;
  return (
    schema.type === "object" &&
    isJsonObject(properties) &&
    Object.keys(properties).length === 0 &&
    (required === undefined || (Array.isArray(required) && required.length === 0)) &&
    (additionalProperties === true ||
      (isJsonObject(additionalProperties) && Object.keys(additionalProperties).length === 0)) &&
    keys.every((key) =>
      ["additionalProperties", "description", "properties", "required", "type"].includes(key),
    )
  );
}
