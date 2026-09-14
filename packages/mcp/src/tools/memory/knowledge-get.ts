import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  externalizeObjectSchema,
  KnowledgeGetInputSchema,
  KnowledgeAgentGetPageSchema,
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
    // The application budgets the actual Agent projection. Continuations do
    // not repeat metadata; REST retains the complete management view.
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (input) => {
      const decoded = knowledgeGetExternal.parse(inputSchema.parse(input));
      const page = KnowledgeAgentGetPageSchema.parse(await service.knowledge.getForAgent(decoded));
      return wrap(page as unknown as Record<string, unknown>);
    },
  };
}
