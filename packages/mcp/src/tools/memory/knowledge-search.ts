import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  externalizeObjectSchema,
  KnowledgeSearchInputSchema,
  KnowledgeSearchPageSchema,
  type ExternalNameMap,
} from "@ayanami-task/protocol";
import { wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { outputSchema } from "../primitives.js";

const knowledgeSearchNames = {
  query: "query",
  tag: "tag",
  includeArchived: "include_archived",
  limit: "limit",
  maxChars: "max_chars",
  cursor: "cursor",
} as const satisfies ExternalNameMap<typeof KnowledgeSearchInputSchema>;

const knowledgeSearchExternal = externalizeObjectSchema(
  KnowledgeSearchInputSchema,
  knowledgeSearchNames,
);
const inputSchema = knowledgeSearchExternal.inputSchema;

/** Search only published knowledge metadata; the body is available through get. */
export function createAtmKnowledgeSearchTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "memory",
    name: "atm_knowledge_search",
    description: "搜索本地共享知识的摘要与适用范围。",
    inputSchema,
    // Application/REST knowledge views are canonical camelCase. MCP accepts
    // snake_case inputs, but keeps this typed read result unchanged so the
    // service's maxChars budget remains valid at the wire boundary. The
    // parsed canonical schema is enforced in the handler; the uninformative
    // public output schema is omitted by publication to stay within memory's
    // descriptor budget, as do the existing read tools.
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (input) => {
      const decoded = knowledgeSearchExternal.parse(inputSchema.parse(input));
      const page = KnowledgeSearchPageSchema.parse(await service.knowledge.search(decoded));
      return wrap(page as unknown as Record<string, unknown>);
    },
  };
}
