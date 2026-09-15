import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  externalizeObjectSchema,
  KnowledgeSearchInputSchema,
  KnowledgeAgentSearchPageSchema,
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
    // Compact Agent metadata is budgeted by the shared application, not
    // clipped from a larger REST response after paging has already happened.
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (input) => {
      const decoded = knowledgeSearchExternal.parse(inputSchema.parse(input));
      const page = KnowledgeAgentSearchPageSchema.parse(
        await service.knowledge.searchForAgent(decoded),
      );
      return wrap(page as unknown as Record<string, unknown>);
    },
  };
}
