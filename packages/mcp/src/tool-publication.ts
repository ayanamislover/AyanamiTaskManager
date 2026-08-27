import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import legacyToolListArtifact from "./legacy-tools-list-v1.0.18.json" with { type: "json" };
import type {
  AyanamiServerProfile,
  ToolDefinition,
  ToolDefinitionRegistry,
} from "./tool-registry.js";

type JsonObject = Record<string, unknown>;

export const LEGACY_TOOL_LIST_ARTIFACT_BYTES = 11_064;
export const LEGACY_TOOL_LIST_ARTIFACT_SHA256 =
  "8fab5e1eff857b3e7d0265d417c0da195194431e0cee37fdc95e4b1a3337a6d7";
// Captured from the unprofiled `/mcp` tools/list response of the released
// v1.0.18 source commit. It is an auditable migration artifact, not a second
// schema generator; current core/memory descriptors always come from Zod.
export const LEGACY_TOOL_LIST_SOURCE_COMMIT = "410969b7fed5f1837078f6731271bf6c18381faf";

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

function isJsonObject(value: unknown): value is JsonObject {
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

function digest(value: unknown): string {
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

  // enum and const already determine the complete accepted value set. Keeping
  // their inferred type repeats validation information without changing it.
  if (normalized.enum !== undefined || normalized.const !== undefined) delete normalized.type;

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
function deduplicateSchema(root: JsonObject): JsonObject {
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

function canonicalRuntimeSchema(schema: z.ZodType): JsonObject {
  const converted = z.toJSONSchema(schema, { io: "input", reused: "inline" });
  if (!isJsonObject(converted)) throw new Error("PUBLIC_SCHEMA_MUST_BE_OBJECT");
  const normalized = normalizeSchemaNode(converted);
  if (!isJsonObject(normalized)) throw new Error("PUBLIC_SCHEMA_MUST_BE_OBJECT");
  return normalized;
}

export function semanticSchemaHash(schema: JsonObject): string {
  const normalized = normalizeSchemaNode(structuredClone(schema));
  return digest(normalized);
}

function isUninformativeObjectSchema(schema: JsonObject): boolean {
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

function publishedTool(definition: ToolDefinition, surfaceVersion: number): Tool {
  const semanticInput = canonicalRuntimeSchema(definition.inputSchema);
  const inputSchema = deduplicateSchema(structuredClone(semanticInput));
  if (inputSchema.type !== "object")
    throw new Error(`PUBLIC_INPUT_MUST_BE_OBJECT:${definition.name}`);
  const semanticOutput = canonicalRuntimeSchema(definition.outputSchema);
  const outputSchema = isUninformativeObjectSchema(semanticOutput)
    ? undefined
    : deduplicateSchema(structuredClone(semanticOutput));
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: inputSchema as Tool["inputSchema"],
    ...(outputSchema === undefined ? {} : { outputSchema: outputSchema as Tool["outputSchema"] }),
    annotations: definition.annotations,
    _meta: {
      ...(definition.protocolMeta ?? {}),
      surface_version: `v${surfaceVersion}`,
      schema_hash: digest(semanticInput),
    },
  };
}

export function publishedTools(
  registry: ToolDefinitionRegistry,
  profile: AyanamiServerProfile,
  surfaceVersion: number,
): readonly Tool[] {
  if (profile === "legacy") {
    const serialized = JSON.stringify(legacyToolListArtifact);
    const bytes = Buffer.byteLength(serialized, "utf8");
    const hash = createHash("sha256").update(serialized, "utf8").digest("hex");
    if (bytes !== LEGACY_TOOL_LIST_ARTIFACT_BYTES || hash !== LEGACY_TOOL_LIST_ARTIFACT_SHA256) {
      throw new Error(`LEGACY_TOOL_LIST_ARTIFACT_CHANGED:${bytes}:${hash}`);
    }
    return Object.freeze(structuredClone(legacyToolListArtifact) as unknown as Tool[]);
  }
  return Object.freeze(
    registry.definitions(profile).map((definition) => publishedTool(definition, surfaceVersion)),
  );
}

export function publishedProfileSchemaHash(
  registry: ToolDefinitionRegistry,
  profile: AyanamiServerProfile,
  surfaceVersion: number,
): string {
  return digest(publishedTools(registry, profile, surfaceVersion));
}

export function generateMcpToolContractMarkdown(
  registry: ToolDefinitionRegistry,
  surfaceVersion: number,
): string {
  const profiles = (["core", "memory"] as const).map((profile) => {
    const tools = publishedTools(registry, profile, surfaceVersion);
    return {
      profile,
      tools,
      bytes: Buffer.byteLength(JSON.stringify(tools), "utf8"),
      hash: publishedProfileSchemaHash(registry, profile, surfaceVersion),
    };
  });
  const rows = profiles.flatMap(({ profile, tools }) =>
    tools.map((tool) => {
      const metadata = tool._meta as { schema_hash?: unknown } | undefined;
      return `| ${profile} | \`${tool.name}\` | ${tool.description ?? ""} | ${String(
        tool.annotations?.readOnlyHint,
      )} | ${String(tool.annotations?.destructiveHint)} | \`${String(metadata?.schema_hash).slice(
        0,
        12,
      )}\` |`;
    }),
  );
  return [
    "# MCP Tool Contracts",
    "",
    "> Generated from `ToolDefinitionRegistry`; do not edit by hand.",
    "",
    `Surface: \`v${surfaceVersion}\``,
    "",
    "| Profile | Descriptor bytes | Profile schema hash |",
    "| --- | ---: | --- |",
    ...profiles.map(({ profile, bytes, hash }) => `| ${profile} | ${bytes} | \`${hash}\` |`),
    "",
    "| Profile | Tool | Description | Read only | Destructive | Schema hash |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Legacy compatibility artifact",
    "",
    `The unprofiled migration endpoint publishes the frozen v1.0.18 artifact from commit \`${LEGACY_TOOL_LIST_SOURCE_COMMIT}\`: ${LEGACY_TOOL_LIST_ARTIFACT_BYTES} bytes, SHA-256 \`${LEGACY_TOOL_LIST_ARTIFACT_SHA256}\`. Current installers only create the formal core and memory profiles.`,
    "",
  ].join("\n");
}

function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export function registerPublishedToolHandlers(
  server: Server,
  registry: ToolDefinitionRegistry,
  profile: AyanamiServerProfile,
  surfaceVersion: number,
): void {
  const definitions = registry.definitions(profile);
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const tools = publishedTools(registry, profile, surfaceVersion);
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...tools] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const definition = byName.get(request.params.name);
    if (!definition) return toolError(`Tool ${request.params.name} not found`);
    let parsed: ReturnType<typeof definition.inputSchema.safeParse>;
    try {
      // Some adapter schemas use transforms that intentionally delegate to a
      // canonical parser. A transform may throw a ZodError before safeParse can
      // wrap it, so the entire runtime parse belongs to the validation channel.
      parsed = definition.inputSchema.safeParse(request.params.arguments ?? {});
    } catch (error) {
      const detail = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
      return toolError(`Invalid arguments for tool ${definition.name}: ${detail}`);
    }
    if (!parsed.success) {
      return toolError(
        `Invalid arguments for tool ${definition.name}: ${z.prettifyError(parsed.error)}`,
      );
    }
    try {
      return await definition.handler(parsed.data, extra as never);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  });
}
