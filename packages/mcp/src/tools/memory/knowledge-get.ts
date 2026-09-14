import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  externalizeObjectSchema,
  KnowledgeGetInputSchema,
  KnowledgeAgentGetPageSchema,
  type ExternalNameMap,
} from "@ayanami-task/protocol";
import { z } from "zod";
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

/**
 * MCP 侧单独收紧 max_chars，不动协议层。
 *
 * 协议层的 600_000 是给 REST 管理视图的——桌面端 readFullEntry 就按这个值一次取全文。
 * 但 MCP 这一侧的消费者是 agent 的上下文窗口：正文本身允许 500KB，按协议上限一次调用
 * 能灌进十几万 token，而其余读工具（task_get / task_list / search / delta）统一是 50_000。
 * 正文再长都该走 cursor 续读，cursor 本来就实现好了。
 */
export const MCP_KNOWLEDGE_GET_MAX_CHARS = 50_000;

const knowledgeGetExternal = externalizeObjectSchema(KnowledgeGetInputSchema, knowledgeGetNames, {
  maxChars: {
    schema: z.number().int().min(1).max(MCP_KNOWLEDGE_GET_MAX_CHARS).default(6000),
    decode: (value) => value,
  },
});
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
