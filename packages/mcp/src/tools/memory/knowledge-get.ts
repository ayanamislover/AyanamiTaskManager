import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  externalizeObjectSchema,
  KnowledgeGetInputSchema,
  KnowledgeGetPageSchema,
  type ExternalNameMap,
} from "@ayanami-task/protocol";
import { wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { outputSchema } from "../primitives.js";

const knowledgeGetNames = {
  id: "id",
  revisionId: "revision_id",
  section: "section",
  maxChars: "max_chars",
  cursor: "cursor",
} as const satisfies ExternalNameMap<typeof KnowledgeGetInputSchema>;

const knowledgeGetExternal = externalizeObjectSchema(KnowledgeGetInputSchema, knowledgeGetNames);
const inputSchema = knowledgeGetExternal.inputSchema;

/** Read one immutable knowledge revisionId, optionally constrained to a section. */
export function createAtmKnowledgeGetTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "memory",
    name: "atm_knowledge_get",
    description: "按 ID 读取固定修订的本地共享知识正文。",
    inputSchema,
    // Keep the canonical typed view and its camelCase fields. The service
    // applies maxChars before this result is serialized by the MCP adapter;
    // handler parsing enforces the canonical schema while the public
    // descriptor's uninformative output schema is omitted by publication to
    // stay within memory's budget.
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (input) => {
      const decoded = knowledgeGetExternal.parse(inputSchema.parse(input));
      const page = KnowledgeGetPageSchema.parse(await service.knowledge.get(decoded));
      return wrap(page as unknown as Record<string, unknown>);
    },
  };
}
