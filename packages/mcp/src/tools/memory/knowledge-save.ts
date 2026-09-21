import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  externalizeObjectSchema,
  KnowledgeAgentSaveInputSchema,
  type ExternalNameMap,
} from "@ayanami-task/protocol";
import { wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { outputSchema } from "../primitives.js";

const external = externalizeObjectSchema(KnowledgeAgentSaveInputSchema, {
  project: "project",
  session: "session",
  opId: "op_id",
  id: "id",
  expectedRevisionId: "expected_revision_id",
  slug: "slug",
  title: "title",
  summary: "summary",
  useWhen: "use_when",
  tags: "tags",
  aliases: "aliases",
  appliesTo: "applies_to",
  bodyMarkdown: "body_markdown",
  sourceRefs: "source_refs",
} as const satisfies ExternalNameMap<typeof KnowledgeAgentSaveInputSchema>);
const inputSchema = external.inputSchema;

export function createAtmKnowledgeSaveTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "memory",
    name: "atm_knowledge_save",
    description:
      "直接发布共享知识，无需手工导入。先查重；更新须带 id 和 expected_revision_id，并提交完整内容；新建省略二者。重试复用 op_id。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (input) => {
      const decoded = external.parse(inputSchema.parse(input));
      return wrap(await service.knowledge.saveForAgent(decoded));
    },
  };
}
