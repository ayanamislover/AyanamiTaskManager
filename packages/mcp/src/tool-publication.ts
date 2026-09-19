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
import { asAtmError, AtmError, atmErrorDto } from "@ayanami-task/errors";
import legacyToolListArtifact from "./legacy-tools-list-v1.0.18.json" with { type: "json" };
import {
  MCP_SCHEMA_LIMIT_BYTES,
  MCP_SCHEMA_RESERVE_BYTES,
  mcpSchemaBytes,
} from "./schema-budget.js";
import type {
  AyanamiServerProfile,
  ToolDefinition,
  ToolDefinitionRegistry,
} from "./tool-registry.js";

import {
  canonicalRuntimeSchema,
  compactDiscriminatedObjectUnions,
  deduplicateSchema,
  digest,
  isJsonObject,
  isUninformativeObjectSchema,
} from "./published-schema.js";
export { normalizePublishedSchema, semanticSchemaHash } from "./published-schema.js";

export const LEGACY_TOOL_LIST_ARTIFACT_BYTES = 11_064;
export const LEGACY_TOOL_LIST_ARTIFACT_SHA256 =
  "8fab5e1eff857b3e7d0265d417c0da195194431e0cee37fdc95e4b1a3337a6d7";
// Captured from the unprofiled `/mcp` tools/list response of the released
// v1.0.18 source commit. It is an auditable migration artifact, not a second
// schema generator; current core/memory/actions descriptors always come from Zod.
export const LEGACY_TOOL_LIST_SOURCE_COMMIT = "410969b7fed5f1837078f6731271bf6c18381faf";

/** 描述里出现 `|`（枚举取值常这么写）会把表格切出多余的列，写进单元格前先转义。 */
function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

/**
 * `_meta.schema_hash` 只用来发现 schema 漂移，没人需要读完整 64 位十六进制。
 *
 * 它按工具收费：每个描述符 64 个字符，core 六个工具就是 288 字节，而 core 的预算
 * 也就那么多——这些字节挤掉的是工具描述，而描述是所有客户端都会显示、agent 真正
 * 拿来判断怎么调用的那一行。16 位十六进制有 64 bit，对十来个工具的漂移检测绰绰有余；
 * 生成的 contract 页本来也只显示前 12 位。
 *
 * 它只是漂移探针：用来判断「这份 schema 和我上次见到的是不是同一份」，以及做缓存失效键。
 * 不要拿它当 schema 身份的证明——64 bit 不是为对抗刻意构造的碰撞准备的。需要强身份时用
 * publishedProfileSchemaHash，那个仍是完整 256 bit。
 */
export const PUBLISHED_SCHEMA_HASH_LENGTH = 16;

function publishedTool(
  definition: ToolDefinition,
  surfaceVersion: number,
  deduplicate: boolean,
): Tool {
  const semanticInput = canonicalRuntimeSchema(definition.inputSchema);
  const compactInput = compactDiscriminatedObjectUnions(structuredClone(semanticInput));
  if (!isJsonObject(compactInput)) throw new Error("PUBLIC_SCHEMA_MUST_BE_OBJECT");
  const inputSchema = deduplicate ? deduplicateSchema(compactInput) : compactInput;
  if (inputSchema.type !== "object")
    throw new Error(`PUBLIC_INPUT_MUST_BE_OBJECT:${definition.name}`);
  const semanticOutput = canonicalRuntimeSchema(definition.outputSchema);
  const outputSchema = isUninformativeObjectSchema(semanticOutput)
    ? undefined
    : deduplicate
      ? deduplicateSchema(structuredClone(semanticOutput))
      : structuredClone(semanticOutput);
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: inputSchema as Tool["inputSchema"],
    ...(outputSchema === undefined ? {} : { outputSchema: outputSchema as Tool["outputSchema"] }),
    annotations: definition.annotations,
    _meta: {
      ...(definition.protocolMeta ?? {}),
      surface_version: `v${surfaceVersion}`,
      schema_hash: digest(semanticInput).slice(0, PUBLISHED_SCHEMA_HASH_LENGTH),
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
  const definitions = registry.definitions(profile);
  // $defs 去重能省字节，但客户端解析 $ref 时会把被抽走的类型渲染成 {}：枚举和联合类型
  // 就此对 agent 不可见，只能靠试错。实测这正是 atm_record.kind、atm_progress_add.scope
  // 被猜错、atm_task_patch.items 被穷举的原因。所以只在预算真的装不下时才付这个代价。
  const inlined = definitions.map((definition) => publishedTool(definition, surfaceVersion, false));
  if (mcpSchemaBytes(inlined) <= MCP_SCHEMA_LIMIT_BYTES - MCP_SCHEMA_RESERVE_BYTES) {
    return Object.freeze(inlined);
  }
  return Object.freeze(
    definitions.map((definition) => publishedTool(definition, surfaceVersion, true)),
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
  const profiles = (["core", "memory", "actions"] as const).map((profile) => {
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
      return `| ${profile} | \`${tool.name}\` | ${markdownCell(tool.description ?? "")} | ${String(
        tool.annotations?.readOnlyHint,
      )} | ${String(tool.annotations?.destructiveHint)} | \`${String(metadata?.schema_hash)}\` |`;
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
    `The unprofiled migration endpoint publishes the frozen v1.0.18 artifact from commit \`${LEGACY_TOOL_LIST_SOURCE_COMMIT}\`: ${LEGACY_TOOL_LIST_ARTIFACT_BYTES} bytes, SHA-256 \`${LEGACY_TOOL_LIST_ARTIFACT_SHA256}\`. Current installers only create the formal core, memory and actions profiles.`,
    "",
  ].join("\n");
}

export const TOOL_ERROR_DETAIL_TEXT_LIMIT = 500;

/**
 * 报错的正文里要带上 details。
 *
 * 很多 MCP 客户端只显示 content 里的那行文本，structuredContent 根本不渲染。于是
 * `COMPLETION_GATE_FAILED: WorkItem 尚未满足完成条件` 就是调用方能看到的全部——
 * 到底缺哪一条、当前状态能做什么，全在没人看得见的 structuredContent 里。
 * 结构化那份仍是完整事实，这里只是把它同样摆到正文里，并夹在一个上限内。
 */
function toolErrorDetailText(details: unknown): string {
  if (!details || typeof details !== "object") return "";
  const issue = (details as { issue?: unknown }).issue;
  // 校验错误的 issue 本来就是排好版的多行文本，原样附上，不要塞进 JSON 再转义一遍。
  if (typeof issue === "string") return `: ${issue}`;
  const rendered = JSON.stringify(details);
  if (!rendered || rendered === "{}") return "";
  return ` ${
    rendered.length > TOOL_ERROR_DETAIL_TEXT_LIMIT
      ? `${rendered.slice(0, TOOL_ERROR_DETAIL_TEXT_LIMIT - 1)}…`
      : rendered
  }`;
}

function toolError(error: unknown): CallToolResult {
  const typed = asAtmError(error);
  const structuredContent = atmErrorDto(typed);
  return {
    content: [
      {
        type: "text",
        text: `${typed.code}: ${typed.message}${toolErrorDetailText(typed.details)}`,
      },
    ],
    structuredContent,
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
    if (!definition)
      return toolError(
        new AtmError("NOT_FOUND", {
          message: `Tool ${request.params.name} not found`,
          details: { entity: "MCP_TOOL", reference: request.params.name },
        }),
      );
    let parsed: ReturnType<typeof definition.inputSchema.safeParse>;
    try {
      // Some adapter schemas use transforms that intentionally delegate to a
      // canonical parser. A transform may throw a ZodError before safeParse can
      // wrap it, so the entire runtime parse belongs to the validation channel.
      parsed = definition.inputSchema.safeParse(request.params.arguments ?? {});
    } catch (error) {
      const detail = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
      return toolError(
        new AtmError("INVALID_ARGUMENT", {
          message: `Invalid arguments for tool ${definition.name}`,
          details: { tool: definition.name, issue: detail },
        }),
      );
    }
    if (!parsed.success) {
      return toolError(
        new AtmError("INVALID_ARGUMENT", {
          message: `Invalid arguments for tool ${definition.name}`,
          details: { tool: definition.name, issue: z.prettifyError(parsed.error) },
        }),
      );
    }
    try {
      return await definition.handler(parsed.data, extra as never);
    } catch (error) {
      return toolError(error);
    }
  });
}
